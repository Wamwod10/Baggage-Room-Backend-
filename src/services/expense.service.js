const prisma = require("../config/prisma");
const { branchWhere, getScopedBranchId } = require("../utils/scope");
const { dateRangeWhere } = require("../utils/date");
const { AppError } = require("../utils/response");
const { audit } = require("./activity.service");
const { findOpenShift, createCashMovement } = require("./cashMovement.service");
const telegram = require("./telegram.service");
const googleSheets = require("./googleSheets.service");
const { requireIdempotencyKey, isUniqueConflictFor } = require("../utils/idempotency");

const includeExpense = {
  branch: { select: { id: true, name: true, code: true } },
  createdBy: { select: { id: true, name: true, login: true } },
  shift: { select: { id: true, acceptedByName: true, openedBy: { select: { id: true, name: true, login: true } } } },
};

const listExpenses = async (user, query) => {
  const where = {
    ...branchWhere(user, query.branchId),
    ...dateRangeWhere(query.dateFrom, query.dateTo),
    ...(query.currency ? { currency: query.currency } : {}),
  };
  if (query.search) where.OR = [{ category: { contains: query.search, mode: "insensitive" } }, { reason: { contains: query.search, mode: "insensitive" } }];
  return prisma.expense.findMany({
    where,
    include: includeExpense,
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(Number(query.limit || 200), 1), 200),
  });
};

const createExpense = async (user, body, { idempotencyKey } = {}) => {
  const branchId = getScopedBranchId(user, body.branchId || user.branchId);
  if (!branchId) throw new AppError("branchId is required", 400);
  const requestKey = requireIdempotencyKey(idempotencyKey);
  const existing = await prisma.expense.findUnique({ where: { idempotencyKey: requestKey }, include: includeExpense });
  if (existing) {
    if (existing.branchId !== branchId) throw new AppError("Idempotency key belongs to another branch", 409);
    return { ...existing, adminName: existing.shift?.acceptedByName || null, idempotentReplay: true };
  }
  let expense;
  try {
    expense = await prisma.$transaction(async (tx) => {
    const shift = await findOpenShift(tx, branchId);
    const expense = await tx.expense.create({
      data: { idempotencyKey: requestKey, branchId, shiftId: shift?.id || null, category: body.category, reason: body.reason, amount: body.amount, currency: body.currency || "UZS", createdById: user.id },
      include: includeExpense,
    });
    await createCashMovement({ tx, branchId, shiftId: shift?.id || null, type: "EXPENSE", direction: "OUT", amount: body.amount, currency: body.currency || "UZS", note: body.reason, createdById: user.id });
    await audit({ tx, branchId, userId: user.id, entityType: "Expense", entityId: expense.id, action: "EXPENSE_CREATE", newValue: expense, description: body.reason });
    return expense;
    });
  } catch (error) {
    if (!isUniqueConflictFor(error, "idempotencyKey")) throw error;
    expense = await prisma.expense.findUnique({ where: { idempotencyKey: requestKey }, include: includeExpense });
    if (!expense || expense.branchId !== branchId) throw error;
    return { ...expense, adminName: expense.shift?.acceptedByName || null, idempotentReplay: true };
  }
  const payload = {
    ...expense,
    adminName: expense.shift?.acceptedByName || null,
  };
  telegram.sendSafely(() => telegram.sendExpense(payload), { action: "EXPENSE", branchId, userId: user.id, entityType: "Expense", entityId: expense.id });
  googleSheets.sendSafely(() => googleSheets.sendExpense(payload), { action: "EXPENSE", branchId, userId: user.id, entityType: "Expense", entityId: expense.id });
  return payload;
};

const deleteExpense = async (user, id) => {
  await prisma.$transaction(async (tx) => {
    const expense = await tx.expense.findUnique({ where: { id } });
    if (!expense) throw new AppError("Expense not found", 404);
    getScopedBranchId(user, expense.branchId);
    await tx.expense.delete({ where: { id } });
    await audit({
      tx,
      branchId: expense.branchId,
      userId: user.id,
      entityType: "Expense",
      entityId: id,
      action: "EXPENSE_DELETE",
      oldValue: expense,
      description: "Expense deleted",
    });
  });
  return { id };
};

module.exports = { listExpenses, createExpense, deleteExpense };
