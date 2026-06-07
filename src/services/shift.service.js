const prisma = require("../config/prisma");
const { AppError } = require("../utils/response");
const { branchWhere, getScopedBranchId } = require("../utils/scope");
const { dateRangeWhere } = require("../utils/date");
const { sum } = require("../utils/money");
const { audit } = require("./activity.service");
const telegram = require("./telegram.service");

const include = {
  branch: { select: { id: true, name: true, code: true } },
  openedBy: { select: { id: true, name: true, login: true } },
  closedBy: { select: { id: true, name: true, login: true } },
};

const listShifts = async (user, query) => {
  const where = { ...branchWhere(user, query.branchId), ...dateRangeWhere(query.dateFrom, query.dateTo, "openedAt"), ...(query.status ? { status: query.status } : {}) };
  return prisma.shift.findMany({ where, include, orderBy: { openedAt: "desc" } });
};

const currentShift = async (user, query = {}) => {
  const branchId = getScopedBranchId(user, query.branchId || user.branchId);
  if (!branchId) return null;
  return prisma.shift.findFirst({ where: { branchId, status: "OPEN" }, include, orderBy: { openedAt: "desc" } });
};

const openShift = async (user, body) => {
  const branchId = getScopedBranchId(user, body.branchId || user.branchId);
  if (!branchId) throw new AppError("branchId is required", 400);
  const existing = await prisma.shift.findFirst({ where: { branchId, status: "OPEN" } });
  if (existing) throw new AppError("This branch already has an open shift", 400);
  const shift = await prisma.shift.create({
    data: {
      branchId,
      openedById: user.id,
      openingCash: body.openingCash || 0,
      acceptedCash: body.acceptedCash || 0,
      acceptedFromName: body.acceptedFromName || null,
      handoverToName: body.handoverToName || null,
    },
    include,
  });
  await audit({ branchId, userId: user.id, entityType: "Shift", entityId: shift.id, action: "SHIFT_OPEN", newValue: shift, description: "Shift opened" });
  telegram.sendSafely(telegram.sendShiftOpen(shift), { branchId, userId: user.id, entityType: "Shift", entityId: shift.id });
  return shift;
};

const computeShiftReport = async (tx, shift) => {
  const movements = await tx.cashMovement.findMany({ where: { shiftId: shift.id } });
  const debts = await tx.debt.findMany({ where: { branchId: shift.branchId, createdAt: { gte: shift.openedAt, lte: new Date() } } });
  const ordersCount = await tx.order.count({ where: { branchId: shift.branchId, createdAt: { gte: shift.openedAt, lte: new Date() } } });

  const inMovements = movements.filter((item) => item.direction === "IN");
  const outMovements = movements.filter((item) => item.direction === "OUT");
  const totalRevenue = sum(inMovements);
  const cashRevenue = sum(inMovements.filter((item) => item.paymentType === "CASH"));
  const cardRevenue = sum(inMovements.filter((item) => item.paymentType === "CARD"));
  const transferRevenue = sum(inMovements.filter((item) => item.paymentType === "TRANSFER"));
  const expenseAmount = sum(outMovements.filter((item) => item.type === "EXPENSE"));
  const inkassaAmount = sum(outMovements.filter((item) => item.type === "INKASSA"));
  const debtAmount = sum(debts.filter((item) => item.status === "OPEN"));
  const manualIn = sum(inMovements.filter((item) => item.type === "MANUAL_CORRECTION"));
  const manualOut = sum(outMovements.filter((item) => item.type === "MANUAL_CORRECTION"));
  const systemExpectedCash = shift.openingCash + shift.acceptedCash + cashRevenue + manualIn - expenseAmount - inkassaAmount - manualOut;

  return { totalRevenue, cashRevenue, cardRevenue, transferRevenue, debtAmount, expenseAmount, inkassaAmount, systemExpectedCash, ordersCount };
};

const closeShift = async (user, id, body) => {
  const result = await prisma.$transaction(async (tx) => {
    const shift = await tx.shift.findUnique({ where: { id } });
    if (!shift || shift.status !== "OPEN") throw new AppError("Bu filialda ochiq smena yo'q", 404);
    getScopedBranchId(user, shift.branchId);
    const { ordersCount, ...report } = await computeShiftReport(tx, shift);
    const closingCash = body.closingCash ?? report.systemExpectedCash;
    const updated = await tx.shift.update({
      where: { id },
      data: {
        ...report,
        closingCash,
        difference: closingCash - report.systemExpectedCash,
        closedById: user.id,
        closedAt: new Date(),
        status: "CLOSED",
        handoverToName: body.handoverToName || shift.handoverToName,
      },
      include,
    });
    const result = { ...updated, ordersCount };
    await audit({ tx, branchId: shift.branchId, userId: user.id, entityType: "Shift", entityId: id, action: "SHIFT_CLOSE", oldValue: shift, newValue: result, description: "Shift closed" });
    return result;
  });
  telegram.sendSafely(telegram.sendShiftClose(result), { branchId: result.branchId, userId: user.id, entityType: "Shift", entityId: id });
  return result;
};

module.exports = { listShifts, currentShift, openShift, closeShift, computeShiftReport };
