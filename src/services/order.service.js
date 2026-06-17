const prisma = require("../config/prisma");
const { AppError } = require("../utils/response");
const { addHours, dateRangeWhere } = require("../utils/date");
const { branchWhere, getScopedBranchId } = require("../utils/scope");
const { generateOrderNumber } = require("../utils/generateOrderId");
const {
  calculatePrice,
  sizesForBranch,
  MULTI_ORDER_LOCKER_BRANCH_CODES,
} = require("./tariff.service");
const { convertUzsToCurrencyMinor } = require("../utils/money");
const { audit } = require("./activity.service");
const { createNotification } = require("./notification.service");
const { findOpenShift, createCashMovement } = require("./cashMovement.service");
const telegram = require("./telegram.service");
const googleSheets = require("./googleSheets.service");
const { paginated } = require("../utils/pagination");

const includeOrder = {
  branch: { select: { id: true, name: true, code: true } },
  createdBy: { select: { id: true, name: true, login: true } },
  pickedUpBy: { select: { id: true, name: true, login: true } },
  cancelledBy: { select: { id: true, name: true, login: true } },
  items: { include: { locker: true } },
  debt: true,
};

const normalizeOrderItems = (body) => {
  if (Array.isArray(body.items) && body.items.length) {
    const invalid = body.items.find((item) => !item || !item.lockerId);
    if (invalid) {
      throw new AppError("lockerId is required for every item", 400, [
        { field: "items.lockerId", message: "lockerId is required" },
      ]);
    }
    return body.items.map((item) => ({
      ...item,
      count: Number.isFinite(Number(item.count)) ? Math.max(1, Number(item.count)) : 1,
    }));
  }
  if (Array.isArray(body.lockerIds) && body.lockerIds.length) {
    const invalid = body.lockerIds.find((lockerId) => !lockerId);
    if (invalid) {
      throw new AppError("lockerId is required", 400, [
        { field: "lockerIds", message: "lockerId is required" },
      ]);
    }
    return body.lockerIds.map((lockerId) => ({ lockerId, count: 1 }));
  }
  throw new AppError("At least one locker is required", 400, [
    { field: "items", message: "items must be a non-empty array" },
  ]);
};

const listOrders = async (user, query) => {
  const where = {
    ...branchWhere(user, query.branchId),
    ...dateRangeWhere(query.dateFrom, query.dateTo),
    ...(query.status ? { status: query.status } : {}),
    ...(query.paymentType ? { paymentType: query.paymentType } : {}),
    ...(query.currency ? { currency: query.currency } : {}),
  };
  if (query.search) {
    where.OR = [
      { orderNumber: { contains: query.search, mode: "insensitive" } },
      { clientName: { contains: query.search, mode: "insensitive" } },
      { phone: { contains: query.search, mode: "insensitive" } },
      { passport: { contains: query.search, mode: "insensitive" } },
    ];
  }
  return paginated(prisma.order, { where, include: includeOrder, orderBy: { createdAt: "desc" }, query });
};

const getOrder = async (user, id) => {
  const order = await prisma.order.findUnique({ where: { id }, include: includeOrder });
  if (!order) throw new AppError("Order not found", 404);
  getScopedBranchId(user, order.branchId);
  return order;
};

const createOrder = async (user, body) => {
  const warnings = [];
  if (!body.branchId) {
    throw new AppError("branchId is required", 400, [
      { field: "branchId", message: "branchId is required" },
    ]);
  }
  if (!body.clientName || !String(body.clientName).trim()) {
    throw new AppError("clientName is required", 400, [
      { field: "clientName", message: "clientName is required" },
    ]);
  }
  if (!body.phone || !String(body.phone).trim()) {
    throw new AppError("phone is required", 400, [
      { field: "phone", message: "phone is required" },
    ]);
  }
  const requestedBranchId = body.branchId;
  const branchId = getScopedBranchId(user, requestedBranchId);
  if (!branchId) throw new AppError("branchId is required", 400, [{ field: "branchId", message: "branchId is required" }]);

  const duplicate = await prisma.order.findFirst({
    where: { branchId, phone: body.phone, status: { in: ["ACTIVE", "DELAYED"] } },
    select: { id: true, orderNumber: true },
  });
  if (duplicate) warnings.push({ type: "DUPLICATE_ACTIVE_CUSTOMER", orderNumber: duplicate.orderNumber });

  const created = await prisma.$transaction(async (tx) => {
    const branch = await tx.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new AppError("Branch not found", 404);

    const inputItems = normalizeOrderItems(body);
    const allowsMultiOrderLockers = MULTI_ORDER_LOCKER_BRANCH_CODES.has(branch.code);
    const lockerIds = inputItems.map((item) => item.lockerId);
    const uniqueLockerIds = [...new Set(lockerIds)];
    const lockers = await tx.locker.findMany({ where: { id: { in: uniqueLockerIds }, branchId } });
    if (lockers.length !== uniqueLockerIds.length) {
      throw new AppError("One or more lockers were not found in this branch", 400, [
        { field: "items.lockerId", message: "Locker not found in this branch" },
      ]);
    }
    for (const locker of lockers) {
      const isBlockedByOccupancy = !allowsMultiOrderLockers && (locker.status !== "EMPTY" || locker.currentOrderId);
      const isBlockedByService = locker.status === "SERVICE";
      if (isBlockedByOccupancy || isBlockedByService) {
        const reason = locker.currentOrderId ? "busy" : String(locker.status || "unavailable").toLowerCase();
        throw new AppError(`Locker ${locker.number} is not available (${reason})`, 400, [
          { field: "items.lockerId", lockerId: locker.id, message: "Locker is busy or in service" },
        ]);
      }
    }

    const tariffs = await tx.tariff.findMany({ where: { branchId } });
    const tariffsBySize = Object.fromEntries(tariffs.map((tariff) => [tariff.size, tariff]));
    const allowedSizes = new Set(sizesForBranch(branch));
    const isCustomTariff = body.customHours !== undefined && body.customHours !== null;
    const tariffHours = Number(body.customHours || body.tariffHours);
    if (!Number.isFinite(tariffHours) || tariffHours <= 0) {
      throw new AppError("tariffHours is required", 400, [
        { field: "tariffHours", message: "tariffHours must be a positive number" },
      ]);
    }
    const currency = body.currency || "UZS";
    const exchangeRate = currency === "UZS" ? 1 : Number(body.exchangeRate || 0);
    if (currency !== "UZS" && (!Number.isFinite(exchangeRate) || exchangeRate <= 0)) {
      throw new AppError(`Exchange rate for ${currency} is required`, 400, [
        { field: "exchangeRate", message: `Exchange rate for ${currency} is required` },
      ]);
    }
    const itemRows = inputItems.map((item) => {
      const locker = lockers.find((row) => row.id === item.lockerId);
      if (!locker) {
        throw new AppError("Locker not found", 400, [
          { field: "items.lockerId", lockerId: item.lockerId, message: "Locker not found" },
        ]);
      }
      const size = item.size;
      if (!size) {
        throw new AppError("Baggage size is required for every item", 400, [
          { field: "items.size", lockerId: item.lockerId, message: "Baggage size is required" },
        ]);
      }
      if (!allowedSizes.has(size)) {
        throw new AppError(`Size ${size} is not available for this branch`, 400, [
          { field: "items.size", size, message: `Size ${size} is not available for this branch` },
        ]);
      }
      const tariff = tariffsBySize[size];
      if (!tariff) {
        throw new AppError(`Tariff for size ${size} not found`, 400, [
          { field: "tariff", size, message: `Tariff for size ${size} not found` },
        ]);
      }
      const itemTariffHours = Number(item.tariffHours || tariffHours);
      if (!Number.isFinite(itemTariffHours) || itemTariffHours <= 0) {
        throw new AppError("tariffHours must be a positive number", 400, [
          { field: "items.tariffHours", lockerId: item.lockerId, message: "tariffHours must be a positive number" },
        ]);
      }
      const count = Number.isFinite(Number(item.count)) ? Math.max(1, Number(item.count)) : 1;
      const unitPriceUZS = calculatePrice(tariff, itemTariffHours, { isCustom: isCustomTariff });
      const unitPrice = convertUzsToCurrencyMinor(unitPriceUZS, currency, exchangeRate);
      const originalPrice = unitPrice * count;
      const discountAmount = Number(item.discountAmount || 0);
      return {
        locker,
        data: {
          lockerId: locker.id,
          lockerNumber: locker.number,
          size,
          count,
          tariffHours: itemTariffHours,
          unitPrice,
          originalPrice,
          discountAmount,
          finalPrice: Math.max(0, originalPrice - discountAmount),
          currency: item.currency || currency,
        },
      };
    });

    const calculatedAmount = itemRows.reduce((total, item) => total + item.data.originalPrice, 0);
    const itemDiscount = itemRows.reduce((total, item) => total + item.data.discountAmount, 0);
    const discountAmount = Number(body.discountAmount || 0) + itemDiscount;
    const finalAmount = Math.max(0, calculatedAmount - discountAmount);
    const realPaidAmount = body.paymentType === "DEBT" ? Number(body.realPaidAmount || 0) : Number(body.realPaidAmount ?? finalAmount);
    const checkIn = body.checkIn ? new Date(body.checkIn) : new Date();
    const plannedCheckOut = body.plannedCheckOut ? new Date(body.plannedCheckOut) : addHours(checkIn, tariffHours);
    const orderNumber = await generateOrderNumber(tx, branch.code);

    const order = await tx.order.create({
      data: {
        orderNumber,
        branchId,
        clientName: body.clientName,
        phone: body.phone,
        passport: body.passport || null,
        tariffHours,
        customHours: body.customHours || null,
        currency,
        paymentType: body.paymentType,
        calculatedAmount,
        discountAmount,
        discountReason: body.discountReason || null,
        finalAmount,
        realPaidAmount,
        paymentDifference: realPaidAmount - finalAmount,
        realPaidReason: body.realPaidReason || null,
        checkIn,
        plannedCheckOut,
        note: body.note || null,
        createdById: user.id,
        items: { create: itemRows.map((item) => item.data) },
      },
      include: includeOrder,
    });

    if (!allowsMultiOrderLockers) {
      for (const locker of lockers) {
        await tx.locker.update({ where: { id: locker.id }, data: { status: "BUSY", currentOrderId: order.id } });
      }
    }

    const shift = await findOpenShift(tx, branchId);
    if (body.paymentType === "DEBT" && finalAmount - realPaidAmount > 0) {
      await tx.debt.create({
        data: { orderId: order.id, branchId, clientName: body.clientName, phone: body.phone, amount: finalAmount - realPaidAmount, currency },
      });
    }
    if (realPaidAmount > 0) {
      await createCashMovement({
        tx,
        branchId,
        shiftId: shift?.id || null,
        orderId: order.id,
        type: "ORDER_PAYMENT",
        direction: "IN",
        amount: realPaidAmount,
        currency,
        paymentType: body.paymentType === "DEBT" ? body.realPaidPaymentType || body.paidPaymentType || "CASH" : body.paymentType,
        note: `Order ${order.orderNumber}`,
        createdById: user.id,
      });
    }

    await createNotification({
      tx,
      branchId,
      type: "SUCCESS",
      title: "Yangi buyurtma",
      message: `${order.orderNumber} ${order.clientName} uchun yaratildi`,
      priority: 1,
      relatedOrderId: order.id,
    });
    await audit({ tx, branchId, userId: user.id, entityType: "Order", entityId: order.id, action: "ORDER_CREATE", newValue: order, description: "Order created" });
    return tx.order.findUnique({ where: { id: order.id }, include: includeOrder });
  });

  telegram.sendSafely(telegram.sendNewOrder(created), { branchId, userId: user.id, entityType: "Order", entityId: created.id });
  googleSheets.sendSafely(() => googleSheets.sendNewOrder(created), { action: "NEW_ORDER", branchId, userId: user.id, entityType: "Order", entityId: created.id });
  return { order: created, warnings };
};

const updateOrder = async (user, id, body) => {
  const current = await getOrder(user, id);
  if (!["ACTIVE", "DELAYED"].includes(current.status)) throw new AppError("Only active orders can be edited", 400);
  const allowed = ["clientName", "phone", "passport", "note", "discountReason", "realPaidReason"];
  const data = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));
  const updated = await prisma.order.update({ where: { id }, data, include: includeOrder });
  await audit({ branchId: current.branchId, userId: user.id, entityType: "Order", entityId: id, action: "ORDER_EDIT", oldValue: current, newValue: updated, description: "Order edited" });
  telegram.sendSafely(telegram.sendOrderEdit({ ...updated, updatedBy: user }, data), { branchId: current.branchId, userId: user.id, entityType: "Order", entityId: id });
  return updated;
};

const pickupOrder = async (user, id, body) => {
  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id }, include: includeOrder });
    if (!order || !["ACTIVE", "DELAYED"].includes(order.status)) throw new AppError("Active order not found", 404);
    getScopedBranchId(user, order.branchId);
    let closedDebt = null;
    let debtPayment = null;
    let debtPaidAmount = 0;

    const pickupTime = body.realPickupTime ? new Date(body.realPickupTime) : new Date();
    const overtimeHours = Math.max(0, Math.ceil((pickupTime.getTime() - order.plannedCheckOut.getTime()) / 3600000));
    const overtimeAmount = Number(body.overtimeAmount || body.extraPayment || 0);
    const updated = await tx.order.update({
      where: { id },
      data: {
        status: "PICKED_UP",
        realPickupTime: pickupTime,
        pickedUpById: user.id,
        overtimeHours,
        overtimeAmount,
      },
      include: includeOrder,
    });

    await tx.locker.updateMany({ where: { currentOrderId: id }, data: { status: "EMPTY", currentOrderId: null } });
    const shift = await findOpenShift(tx, order.branchId);
    if (overtimeAmount > 0) {
      await createCashMovement({
        tx,
        branchId: order.branchId,
        shiftId: shift?.id || null,
        orderId: id,
        type: "ORDER_PAYMENT",
        direction: "IN",
        amount: overtimeAmount,
        currency: body.currency || order.currency,
        paymentType: body.paymentType || "CASH",
        note: `Overtime ${order.orderNumber}`,
        createdById: user.id,
      });
    }
    if (order.debt?.status === "OPEN" && body.debtPaidAmount !== undefined) {
      debtPaidAmount = Number(body.debtPaidAmount);
      if (debtPaidAmount > order.debt.amount) throw new AppError("Debt payment cannot exceed open debt amount", 400);
      if (debtPaidAmount > 0) {
        const remainingDebtAmount = order.debt.amount - debtPaidAmount;
        await createCashMovement({
          tx,
          branchId: order.branchId,
          shiftId: shift?.id || null,
          orderId: id,
          type: "DEBT_CLOSE",
          direction: "IN",
          amount: debtPaidAmount,
          currency: body.currency || order.currency,
          paymentType: body.paymentType || "CASH",
          note: `Debt payment ${order.orderNumber}`,
          createdById: user.id,
        });
        await tx.debt.update({
          where: { id: order.debt.id },
          data: { amount: remainingDebtAmount },
        });
        debtPayment = {
          ...order.debt,
          amount: remainingDebtAmount,
          paidAmount: debtPaidAmount,
          paymentType: body.paymentType || "CASH",
          currency: body.currency || order.currency,
          status: remainingDebtAmount === 0 ? "CLOSED" : "OPEN",
          paidAt: pickupTime,
          closedAt: remainingDebtAmount === 0 ? pickupTime : null,
          branch: order.branch,
          order: {
            id: order.id,
            orderNumber: order.orderNumber,
            passport: order.passport,
            checkIn: order.checkIn,
            plannedCheckOut: order.plannedCheckOut,
            realPickupTime: pickupTime,
          },
          closedBy: user,
        };
      }
      if (debtPaidAmount === order.debt.amount) {
        closedDebt = await tx.debt.update({
          where: { id: order.debt.id },
          data: { status: "CLOSED", closedAt: new Date(), closedById: user.id },
          include: {
            branch: { select: { id: true, name: true, code: true } },
            order: { select: { id: true, orderNumber: true, passport: true, checkIn: true, plannedCheckOut: true, realPickupTime: true } },
            closedBy: { select: { id: true, name: true, login: true } },
          },
        });
        debtPayment = {
          ...closedDebt,
          paidAmount: debtPaidAmount,
          paymentType: body.paymentType || "CASH",
          currency: body.currency || order.currency,
          closedBy: closedDebt.closedBy || user,
          paidAt: closedDebt.closedAt || pickupTime,
        };
      }
    }
    await audit({ tx, branchId: order.branchId, userId: user.id, entityType: "Order", entityId: id, action: "ORDER_PICKUP", oldValue: order, newValue: updated, description: "Order picked up" });
    if (overtimeAmount > 0) {
      telegram.sendSafely(telegram.sendOvertimePayment({ ...updated, overtimePaymentType: body.paymentType || "CASH" }), { branchId: order.branchId, userId: user.id, entityType: "Order", entityId: id });
    }
    return { updated, closedDebt, debtPayment, debtPaidAmount };
  });
  if (result.debtPayment) {
    telegram.sendSafely(telegram.sendDebtClosed(result.debtPayment), { branchId: result.updated.branchId, userId: user.id, entityType: "Debt", entityId: result.debtPayment.id });
  }
  return result.updated;
};

const cancelOrder = async (user, id, body) => {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id }, include: includeOrder });
    if (!order || !["ACTIVE", "DELAYED"].includes(order.status)) throw new AppError("Active order not found", 404);
    getScopedBranchId(user, order.branchId);
    const updated = await tx.order.update({
      where: { id },
      data: { status: "CANCELLED", cancelledById: user.id, cancelReason: body.cancelReason || body.reason || null },
      include: includeOrder,
    });
    await tx.locker.updateMany({ where: { currentOrderId: id }, data: { status: "EMPTY", currentOrderId: null } });
    await createNotification({
      tx,
      branchId: order.branchId,
      type: "WARNING",
      title: "Buyurtma bekor qilindi",
      message: `${order.orderNumber} bekor qilindi`,
      priority: 2,
      relatedOrderId: order.id,
    });
    await audit({ tx, branchId: order.branchId, userId: user.id, entityType: "Order", entityId: id, action: "ORDER_CANCEL", oldValue: order, newValue: updated, description: body.cancelReason || "Order cancelled" });
    telegram.sendSafely(telegram.sendOrderCancel(updated), { branchId: order.branchId, userId: user.id, entityType: "Order", entityId: id });
    return updated;
  });
};

const markDelayedOrders = async (branchId = undefined) => {
  const now = new Date();
  const overdue = await prisma.order.findMany({
    where: { ...(branchId ? { branchId } : {}), status: "ACTIVE", plannedCheckOut: { lt: now } },
    include: {
      branch: { select: { id: true, name: true } },
      items: { select: { lockerNumber: true, locker: { select: { number: true } } } },
    },
  });
  for (const order of overdue) {
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: "DELAYED" } });
      await tx.locker.updateMany({ where: { currentOrderId: order.id }, data: { status: "DELAYED" } });
      await createNotification({
        tx,
        branchId: order.branchId,
        type: "DANGER",
        title: "Kechikkan bagaj",
        message: `${order.orderNumber} olib ketish vaqtidan o'tdi`,
        priority: 3,
        relatedOrderId: order.id,
      });
    });
    telegram.sendSafely(telegram.sendDelayedBaggage(order), { branchId: order.branchId, entityType: "Order", entityId: order.id });
  }
  return overdue.length;
};

module.exports = { listOrders, getOrder, createOrder, updateOrder, pickupOrder, cancelOrder, markDelayedOrders };
