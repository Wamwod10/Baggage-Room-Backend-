const prisma = require("../config/prisma");
const { AppError } = require("../utils/response");
const { branchWhere, getScopedBranchId } = require("../utils/scope");
const { dateRangeWhere } = require("../utils/date");
const { audit } = require("./activity.service");
const { findOpenShift, createCashMovement } = require("./cashMovement.service");
const telegram = require("./telegram.service");
const googleSheets = require("./googleSheets.service");
const { normalizePaymentType } = require("../utils/payment");

const includeDebt = {
  order: { select: { id: true, orderNumber: true, status: true, passport: true, checkIn: true, plannedCheckOut: true, realPickupTime: true } },
  branch: { select: { id: true, name: true, code: true } },
  closedBy: { select: { id: true, name: true, login: true } },
};

const listDebts = async (user, query) => {
  const where = {
    ...branchWhere(user, query.branchId),
    ...dateRangeWhere(query.dateFrom, query.dateTo),
    ...(query.status ? { status: query.status } : {}),
    ...(query.currency ? { currency: query.currency } : {}),
  };
  if (query.search) {
    where.OR = [
      { clientName: { contains: query.search, mode: "insensitive" } },
      { phone: { contains: query.search, mode: "insensitive" } },
      { order: { is: { orderNumber: { contains: query.search, mode: "insensitive" } } } },
    ];
  }
  return prisma.debt.findMany({
    where,
    include: includeDebt,
    orderBy: { createdAt: "desc" },
  });
};

const closeDebt = async (user, id, body) => {
  const result = await prisma.$transaction(async (tx) => {
    const debt = await tx.debt.findUnique({ where: { id }, include: { order: true } });
    if (!debt) throw new AppError("Debt not found", 404);
    if (debt.status === "CLOSED") throw new AppError("Debt is already closed", 400);
    getScopedBranchId(user, debt.branchId);
    const paidAmount = body.amount ?? debt.amount;
    const paymentType = normalizePaymentType(body.paymentType);
    if (paidAmount <= 0) throw new AppError("Debt payment amount must be positive", 400);
    if (paidAmount !== debt.amount) throw new AppError("Debt close amount must equal open debt amount", 400);
    if (!paymentType) throw new AppError("paymentType is required", 400);
    const shift = await findOpenShift(tx, debt.branchId);

    const updated = await tx.debt.update({
      where: { id },
      data: { status: "CLOSED", closedAt: new Date(), closedById: user.id },
      include: includeDebt,
    });
    await createCashMovement({
      tx,
      branchId: debt.branchId,
      shiftId: shift?.id || null,
      orderId: debt.orderId,
      type: "DEBT_CLOSE",
      direction: "IN",
      amount: paidAmount,
      currency: body.currency || debt.currency,
      paymentType,
      note: body.note || `Debt closed for ${debt.order.orderNumber}`,
      createdById: user.id,
    });
    const newRealPaidAmount = Number(debt.order.realPaidAmount || 0) + Number(paidAmount || 0);
    await tx.order.update({
      where: { id: debt.orderId },
      data: {
        realPaidAmount: newRealPaidAmount,
        paymentDifference: newRealPaidAmount - Number(debt.order.finalAmount || 0),
      },
    });
    await audit({ tx, branchId: debt.branchId, userId: user.id, entityType: "Debt", entityId: id, action: "DEBT_CLOSE", oldValue: debt, newValue: updated, description: "Debt closed" });
    telegram.sendSafely(
      () => telegram.sendDebtClosed({
        ...updated,
        paidAmount,
        paymentType,
        currency: body.currency || debt.currency,
        closedBy: updated.closedBy || user,
        paidAt: updated.closedAt,
      }),
      { action: "DEBT_CLOSED", branchId: debt.branchId, userId: user.id, entityType: "Debt", entityId: id },
    );
    return {
      ...updated,
      paidAmount,
      paymentType,
      currency: body.currency || debt.currency,
    };
  });
  googleSheets.sendSafely(
    () => googleSheets.sendDebtPayment(result, { amount: result.paidAmount, paymentType: result.paymentType, currency: result.currency }),
    { action: "DEBT_PAYMENT", branchId: result.branchId, userId: user.id, entityType: "DebtPayment", entityId: `${id}:${result.closedAt?.getTime?.() || Date.now()}` },
  );
  return result;
};

module.exports = { listDebts, closeDebt };
