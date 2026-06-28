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
const { normalizePaymentType, paymentLabel } = require("../utils/payment");

const includeOrder = {
  branch: { select: { id: true, name: true, code: true } },
  createdBy: { select: { id: true, name: true, login: true } },
  pickedUpBy: { select: { id: true, name: true, login: true } },
  cancelledBy: { select: { id: true, name: true, login: true } },
  items: { include: { locker: true } },
  debt: true,
};

const telegramReasonText = {
  settings_not_found: "Telegram sozlamalari topilmadi",
  missing_credentials: "Bot token yoki chat ID kiritilmagan",
  disabled: "Telegram o'chirilgan",
  newOrderEnabled_disabled: "Yangi buyurtma xabari o'chirilgan",
};

const changeLabels = {
  clientName: "Mijoz",
  phone: "Telefon",
  passport: "Passport",
  plannedCheckOut: "Check-out",
  paymentType: "To'lov",
  currency: "Valyuta",
  finalAmount: "Summa",
  realPaidAmount: "Real to'lov",
  note: "Izoh",
  items: "Bagaj",
};

const formatChangeValue = (key, value, currency = "UZS") => {
  if (value === undefined || value === null || value === "") return "-";
  if (key === "paymentType") return paymentLabel(value, { context: "order_edit" });
  if (["finalAmount", "realPaidAmount"].includes(key)) return `${Number(value || 0)} ${currency}`;
  if (key === "plannedCheckOut") return new Date(value).toISOString();
  return String(value);
};

const buildEditChanges = (before, after, keys) => keys.reduce((changes, key) => {
  const oldValue = before[key] instanceof Date ? before[key].toISOString() : before[key];
  const nextValue = after[key] instanceof Date ? after[key].toISOString() : after[key];
  if (oldValue !== nextValue) {
    changes[changeLabels[key] || key] = {
      old: formatChangeValue(key, oldValue, before.currency),
      next: formatChangeValue(key, nextValue, after.currency),
    };
  }
  return changes;
}, {});

const netMovementsByBucket = (movements = []) => {
  const buckets = new Map();
  for (const movement of movements) {
    if (!["ORDER_PAYMENT", "DEBT_CLOSE"].includes(movement.type)) continue;
    const key = [movement.type, movement.paymentType || "", movement.currency || "UZS"].join("|");
    const current = buckets.get(key) || {
      type: movement.type,
      paymentType: movement.paymentType,
      currency: movement.currency || "UZS",
      amount: 0,
    };
    current.amount += Number(movement.amount || 0) * (movement.direction === "OUT" ? -1 : 1);
    buckets.set(key, current);
  }
  return [...buckets.values()].filter((bucket) => bucket.amount !== 0);
};

const reverseRevenueMovements = async ({ tx, order, movements, userId, notePrefix = "Reversal" }) => {
  const shift = await findOpenShift(tx, order.branchId);
  const reversals = [];
  for (const bucket of netMovementsByBucket(movements)) {
    const amount = Math.abs(bucket.amount);
    if (!amount) continue;
    reversals.push(await createCashMovement({
      tx,
      branchId: order.branchId,
      shiftId: shift?.id || null,
      orderId: order.id,
      type: bucket.type,
      direction: bucket.amount > 0 ? "OUT" : "IN",
      amount,
      currency: bucket.currency,
      paymentType: bucket.paymentType || null,
      note: `${notePrefix} ${order.orderNumber}`,
      createdById: userId,
    }));
  }
  return reversals;
};

const resetInitialPaymentMovement = async ({ tx, order, amount, currency, paymentType, userId }) => {
  const existing = await tx.cashMovement.findMany({
    where: {
      orderId: order.id,
      type: "ORDER_PAYMENT",
      note: { not: { startsWith: "Overtime" } },
    },
  });
  await reverseRevenueMovements({ tx, order, movements: existing, userId, notePrefix: "Edit reversal" });
  if (amount > 0) {
    const shift = await findOpenShift(tx, order.branchId);
    await createCashMovement({
      tx,
      branchId: order.branchId,
      shiftId: shift?.id || null,
      orderId: order.id,
      type: "ORDER_PAYMENT",
      direction: "IN",
      amount,
      currency,
      paymentType,
      note: `Order ${order.orderNumber}`,
      createdById: userId,
    });
  }
};

const normalizeTelegramResult = (result = {}) => {
  const sent = !result?.skipped && result?.ok !== false;
  const reason = result?.error || result?.reason || "";
  return {
    sent,
    skipped: Boolean(result?.skipped),
    reason,
    message: sent ? "Telegram xabari yuborildi" : telegramReasonText[reason] || reason || "Telegram yuborilmadi",
    messageId: result?.result?.message_id || null,
  };
};

const sendNewOrderTelegram = async (order, meta = {}) => {
  const result = await telegram.sendSafely(
    () => telegram.sendNewOrder(order),
    {
      action: meta.action || "NEW_ORDER",
      branchId: order.branchId,
      userId: meta.userId || null,
      entityType: meta.entityType || "Order",
      entityId: meta.entityId || order.id,
    },
  );
  return normalizeTelegramResult(result);
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
    const paymentType = normalizePaymentType(body.paymentType);
    if (!paymentType) throw new AppError("paymentType is required", 400, [
      { field: "paymentType", message: "paymentType is required" },
    ]);
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
    const realPaidAmount = paymentType === "DEBT" ? Number(body.realPaidAmount || 0) : Number(body.realPaidAmount ?? finalAmount);
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
        paymentType,
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
    if (paymentType === "DEBT" && finalAmount - realPaidAmount > 0) {
      await tx.debt.create({
        data: { orderId: order.id, branchId, clientName: body.clientName, phone: body.phone, amount: finalAmount - realPaidAmount, currency },
      });
    }
    const paidPaymentType = paymentType === "DEBT" ? normalizePaymentType(body.realPaidPaymentType || body.paidPaymentType) : paymentType;
    if (realPaidAmount > 0 && !paidPaymentType) {
      throw new AppError("paidPaymentType is required for partial debt payment", 400);
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
        paymentType: paidPaymentType,
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

  const telegramResult = await sendNewOrderTelegram(created, { userId: user.id });
  if (!telegramResult.sent) {
    warnings.push({ type: "TELEGRAM_NOT_SENT", message: telegramResult.message, reason: telegramResult.reason });
  }
  googleSheets.sendSafely(() => googleSheets.sendNewOrder(created), { action: "NEW_ORDER", branchId, userId: user.id, entityType: "Order", entityId: created.id });
  return { order: created, warnings, telegram: telegramResult };
};

const sendOrderTelegram = async (user, id) => {
  const order = await getOrder(user, id);
  const result = await sendNewOrderTelegram(order, {
    action: "NEW_ORDER_MANUAL",
    userId: user.id,
    entityType: "OrderTelegram",
    entityId: `${id}:manual:${Date.now()}`,
  });
  if (!result.sent) throw new AppError(`Telegram yuborilmadi: ${result.message}`, 502);
  return result;
};

const updateOrder = async (user, id, body) => {
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.order.findUnique({ where: { id }, include: includeOrder });
    if (!current) throw new AppError("Order not found", 404);
    getScopedBranchId(user, current.branchId);
    if (!["ACTIVE", "DELAYED"].includes(current.status)) throw new AppError("Only active orders can be edited", 400);

    const data = {};
    for (const key of ["clientName", "phone", "passport", "note", "discountReason", "realPaidReason"]) {
      if (body[key] !== undefined) data[key] = body[key] || null;
    }
    if (body.checkOut !== undefined || body.plannedCheckOut !== undefined) {
      const plannedCheckOut = new Date(body.plannedCheckOut || body.checkOut);
      if (Number.isNaN(plannedCheckOut.getTime())) throw new AppError("Invalid checkOut", 400);
      data.plannedCheckOut = plannedCheckOut;
      data.status = plannedCheckOut < new Date() ? "DELAYED" : "ACTIVE";
    }
    if (body.paymentType !== undefined) {
      const paymentType = normalizePaymentType(body.paymentType);
      if (!paymentType) throw new AppError("paymentType is required", 400);
      data.paymentType = paymentType;
    }
    if (body.currency !== undefined) data.currency = body.currency;
    if (body.finalAmount !== undefined) data.finalAmount = Number(body.finalAmount);
    if (body.realPaidAmount !== undefined) data.realPaidAmount = Number(body.realPaidAmount);

    const nextPaymentType = data.paymentType || current.paymentType;
    if (nextPaymentType === "DEBT" && body.realPaidAmount === undefined) data.realPaidAmount = 0;
    const nextFinalAmount = data.finalAmount ?? current.finalAmount;
    const nextRealPaidAmount = data.realPaidAmount ?? current.realPaidAmount;
    data.paymentDifference = Number(nextRealPaidAmount || 0) - Number(nextFinalAmount || 0);

    let itemChanged = false;
    if (Array.isArray(body.items)) {
      const currentItemsById = new Map(current.items.map((item) => [item.id, item]));
      for (const item of body.items) {
        const currentItem = currentItemsById.get(item.id);
        if (!currentItem) continue;
        const itemData = {};
        if (item.size !== undefined) itemData.size = item.size;
        if (item.count !== undefined) itemData.count = Number(item.count);
        if (data.currency) itemData.currency = data.currency;
        if (item.lockerId && item.lockerId !== currentItem.lockerId) {
          const locker = await tx.locker.findUnique({ where: { id: item.lockerId } });
          if (!locker || locker.branchId !== current.branchId) throw new AppError("Locker not found in this branch", 400);
          if (locker.status !== "EMPTY" || locker.currentOrderId) throw new AppError("New locker must be empty", 400);
          await tx.locker.update({ where: { id: currentItem.lockerId }, data: { status: "EMPTY", currentOrderId: null } });
          await tx.locker.update({ where: { id: locker.id }, data: { status: data.status === "DELAYED" ? "DELAYED" : "BUSY", currentOrderId: id } });
          itemData.lockerId = locker.id;
          itemData.lockerNumber = locker.number;
          itemData.size = itemData.size || locker.size;
        }
        if (Object.keys(itemData).length) {
          await tx.orderItem.update({ where: { id: currentItem.id }, data: itemData });
          itemChanged = true;
        }
      }
    }

    const updatedBase = await tx.order.update({ where: { id }, data, include: includeOrder });
    const nextDebtAmount = Math.max(0, Number(updatedBase.finalAmount || 0) - Number(updatedBase.realPaidAmount || 0));
    if (updatedBase.paymentType === "DEBT" && nextDebtAmount > 0) {
      await tx.debt.upsert({
        where: { orderId: id },
        create: {
          orderId: id,
          branchId: updatedBase.branchId,
          clientName: updatedBase.clientName,
          phone: updatedBase.phone,
          amount: nextDebtAmount,
          currency: updatedBase.currency,
        },
        update: {
          status: "OPEN",
          closedAt: null,
          closedById: null,
          clientName: updatedBase.clientName,
          phone: updatedBase.phone,
          amount: nextDebtAmount,
          currency: updatedBase.currency,
        },
      });
    } else if (current.debt) {
      await tx.debt.update({
        where: { id: current.debt.id },
        data: { status: "CLOSED", amount: 0, closedAt: new Date(), closedById: user.id },
      });
    }

    const paymentFieldsChanged = ["paymentType", "currency", "finalAmount", "realPaidAmount"].some((key) => body[key] !== undefined);
    if (paymentFieldsChanged) {
      await resetInitialPaymentMovement({
        tx,
        order: current,
        amount: Number(updatedBase.realPaidAmount || 0),
        currency: updatedBase.currency,
        paymentType: updatedBase.paymentType === "DEBT" ? null : updatedBase.paymentType,
        userId: user.id,
      });
    }

    if (data.status) {
      await tx.locker.updateMany({ where: { currentOrderId: id }, data: { status: data.status === "DELAYED" ? "DELAYED" : "BUSY" } });
    }

    const updated = await tx.order.findUnique({ where: { id }, include: includeOrder });
    const changes = buildEditChanges(current, updated, ["clientName", "phone", "passport", "plannedCheckOut", "paymentType", "currency", "finalAmount", "realPaidAmount", "note"]);
    if (itemChanged) changes[changeLabels.items] = { old: "oldingi", next: "yangilandi" };
    await audit({ tx, branchId: current.branchId, userId: user.id, entityType: "Order", entityId: id, action: "ORDER_EDIT", oldValue: current, newValue: updated, description: "Order edited" });
    return { updated, changes };
  });

  telegram.sendSafely(
    () => telegram.sendOrderEdit({ ...result.updated, updatedBy: user }, result.changes),
    { action: "ORDER_EDIT", branchId: result.updated.branchId, userId: user.id, entityType: "Order", entityId: `${id}:edit:${result.updated.updatedAt.getTime()}` },
  );
  return result.updated;
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
    const overtimeCurrency = body.currency || order.currency;
    const overtimePaymentType = normalizePaymentType(body.paymentType);
    if ((Number(body.overtimeAmount || body.extraPayment || 0) > 0 || Number(body.debtPaidAmount || 0) > 0) && !overtimePaymentType) {
      throw new AppError("paymentType is required", 400);
    }
    let updated = await tx.order.update({
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
        currency: overtimeCurrency,
        paymentType: overtimePaymentType,
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
          paymentType: overtimePaymentType,
          note: `Debt payment ${order.orderNumber}`,
          createdById: user.id,
        });
        await tx.debt.update({
          where: { id: order.debt.id },
          data: { amount: remainingDebtAmount },
        });
        const newRealPaidAmount = Number(order.realPaidAmount || 0) + debtPaidAmount;
        updated = await tx.order.update({
          where: { id },
          data: {
            realPaidAmount: newRealPaidAmount,
            paymentDifference: newRealPaidAmount - Number(order.finalAmount || 0),
          },
          include: includeOrder,
        });
        debtPayment = {
          ...order.debt,
          amount: remainingDebtAmount,
          paidAmount: debtPaidAmount,
          paymentType: overtimePaymentType,
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
          paymentType: overtimePaymentType,
          currency: body.currency || order.currency,
          closedBy: closedDebt.closedBy || user,
          paidAt: closedDebt.closedAt || pickupTime,
        };
      }
    }
    await audit({ tx, branchId: order.branchId, userId: user.id, entityType: "Order", entityId: id, action: "ORDER_PICKUP", oldValue: order, newValue: updated, description: "Order picked up" });
    if (overtimeAmount > 0) {
      const shiftOpenedBy = shift?.acceptedByName || shift?.openedBy || null;
      telegram.sendSafely(
        () => telegram.sendOvertimePayment({ ...updated, currency: overtimeCurrency, overtimeCurrency, overtimePaymentType, shiftOpenedBy }),
        { action: "OVERTIME_PAYMENT", branchId: order.branchId, userId: user.id, entityType: "Order", entityId: `${id}:overtime` },
      );
    }
    return { updated: { ...updated, overtimeCurrency, overtimePaymentType }, closedDebt, debtPayment, debtPaidAmount };
  });
  if (result.debtPayment) {
    telegram.sendSafely(
      () => telegram.sendDebtClosed(result.debtPayment),
      { action: "DEBT_CLOSED", branchId: result.updated.branchId, userId: user.id, entityType: "Debt", entityId: result.debtPayment.id },
    );
    googleSheets.sendSafely(
      () => googleSheets.sendDebtPayment(result.debtPayment, {
        amount: result.debtPayment.paidAmount,
        paymentType: result.debtPayment.paymentType,
        currency: result.debtPayment.currency,
      }),
      {
        action: "DEBT_PAYMENT",
        branchId: result.updated.branchId,
        userId: user.id,
        entityType: "DebtPayment",
        entityId: `${result.debtPayment.id}:${result.debtPayment.paidAt?.getTime?.() || result.updated.realPickupTime?.getTime?.() || Date.now()}`,
      },
    );
  }
  if (Number(result.updated.overtimeAmount || 0) > 0) {
    googleSheets.sendSafely(
      () => googleSheets.sendDoplata({ ...result.updated, overtimePaymentType: normalizePaymentType(body.paymentType) }),
      { action: "DOPLATA", branchId: result.updated.branchId, userId: user.id, entityType: "OrderDoplata", entityId: `${id}:doplata:${result.updated.realPickupTime?.getTime?.() || Date.now()}` },
    );
  }
  return result.updated;
};

const cancelOrder = async (user, id, body) => {
  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id }, include: includeOrder });
    if (!order || !["ACTIVE", "DELAYED"].includes(order.status)) throw new AppError("Active order not found", 404);
    getScopedBranchId(user, order.branchId);
    const updated = await tx.order.update({
      where: { id },
      data: { status: "CANCELLED", cancelledById: user.id, cancelReason: body.cancelReason || body.reason || null },
      include: includeOrder,
    });
    await tx.locker.updateMany({ where: { currentOrderId: id }, data: { status: "EMPTY", currentOrderId: null } });
    if (order.debt?.status === "OPEN") {
      await tx.debt.update({
        where: { id: order.debt.id },
        data: { status: "CLOSED", amount: 0, closedAt: new Date(), closedById: user.id },
      });
    }
    const paidMovements = await tx.cashMovement.findMany({
      where: { orderId: id, type: { in: ["ORDER_PAYMENT", "DEBT_CLOSE"] } },
    });
    const reversals = await reverseRevenueMovements({
      tx,
      order,
      movements: paidMovements,
      userId: user.id,
      notePrefix: "Cancel reversal",
    });
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
    return {
      updated: {
        ...updated,
        cancelledAmount: reversals.reduce((total, item) => total + Number(item.amount || 0), 0),
      },
      reversals,
    };
  });
  telegram.sendSafely(() => telegram.sendOrderCancel(result.updated), { action: "ORDER_CANCEL", branchId: result.updated.branchId, userId: user.id, entityType: "Order", entityId: id });
  for (const reversal of result.reversals) {
    googleSheets.sendSafely(
      () => googleSheets.sendOrderCancel(result.updated, reversal),
      { action: "CANCEL_ORDER", branchId: result.updated.branchId, userId: user.id, entityType: "OrderCancel", entityId: `${id}:${reversal.id}` },
    );
  }
  return result.updated;
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
  let markedCount = 0;
  for (const order of overdue) {
    const marked = await prisma.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({ where: { id: order.id, status: "ACTIVE" }, data: { status: "DELAYED" } });
      if (updated.count === 0) return false;
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
      return true;
    });
    if (marked) {
      markedCount += 1;
      telegram.sendSafely(() => telegram.sendDelayedBaggage(order), { action: "DELAYED_BAGGAGE", branchId: order.branchId, entityType: "Order", entityId: order.id });
    }
  }
  return markedCount;
};

module.exports = { listOrders, getOrder, createOrder, updateOrder, pickupOrder, cancelOrder, markDelayedOrders, sendOrderTelegram };
