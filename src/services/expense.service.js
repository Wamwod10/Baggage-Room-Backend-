const prisma = require("../config/prisma");
const { branchWhere, getScopedBranchId } = require("../utils/scope");
const { dateRangeWhere } = require("../utils/date");
const { AppError } = require("../utils/response");
const { audit } = require("./activity.service");
const { findOpenShift, createCashMovement } = require("./cashMovement.service");
const telegram = require("./telegram.service");
const googleSheets = require("./googleSheets.service");

const includeExpense = {
  branch: { select: { id: true, name: true, code: true } },
  createdBy: { select: { id: true, name: true, login: true } },
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
  });
};

const createExpense = async (user, body) => {
  const branchId = getScopedBranchId(user, body.branchId || user.branchId);
  if (!branchId) throw new AppError("branchId is required", 400);
  const expense = await prisma.$transaction(async (tx) => {
    const shift = await findOpenShift(tx, branchId);
    const expense = await tx.expense.create({
      data: { branchId, shiftId: shift?.id || null, category: body.category, reason: body.reason, amount: body.amount, currency: body.currency || "UZS", createdById: user.id },
      include: includeExpense,
    });
    await createCashMovement({ tx, branchId, shiftId: shift?.id || null, type: "EXPENSE", direction: "OUT", amount: body.amount, currency: body.currency || "UZS", note: body.reason, createdById: user.id });
    await audit({ tx, branchId, userId: user.id, entityType: "Expense", entityId: expense.id, action: "EXPENSE_CREATE", newValue: expense, description: body.reason });
    return expense;
  });
  telegram.sendSafely(telegram.sendExpense(expense), { branchId, userId: user.id, entityType: "Expense", entityId: expense.id });
  await googleSheets.sendSafely(googleSheets.sendExpense(expense), { action: "EXPENSE", branchId, userId: user.id, entityType: "Expense", entityId: expense.id });
  return expense;
};

const deleteExpense = async (user, id) => {
  const expense = await prisma.expense.findUnique({ where: { id } });
  if (!expense) throw new AppError("Expense not found", 404);
  getScopedBranchId(user, expense.branchId);
  await audit({
    branchId: expense.branchId,
    userId: user.id,
    entityType: "Expense",
    entityId: id,
    action: "EXPENSE_DELETE",
    oldValue: expense,
    description: "Expense deleted",
  });
  await prisma.expense.delete({ where: { id } });
  return { id };
};

module.exports = { listExpenses, createExpense, deleteExpense };
