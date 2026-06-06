const prisma = require("../config/prisma");
const { branchWhere } = require("../utils/scope");
const { dateRangeWhere } = require("../utils/date");
const { paginated } = require("../utils/pagination");

const findOpenShift = (tx, branchId) => tx.shift.findFirst({ where: { branchId, status: "OPEN" } });

const createCashMovement = async ({ tx = prisma, branchId, shiftId, orderId = null, type, direction, amount, currency, paymentType = null, note = null, createdById }) => {
  return tx.cashMovement.create({
    data: { branchId, shiftId, orderId, type, direction, amount, currency, paymentType, note, createdById },
  });
};

const listCashMovements = async (user, query) => {
  const where = {
    ...branchWhere(user, query.branchId),
    ...dateRangeWhere(query.dateFrom, query.dateTo),
    ...(query.currency ? { currency: query.currency } : {}),
    ...(query.paymentType ? { paymentType: query.paymentType } : {}),
  };
  if (query.search) {
    where.OR = [
      { note: { contains: query.search, mode: "insensitive" } },
      { order: { is: { orderNumber: { contains: query.search, mode: "insensitive" } } } },
      { order: { is: { clientName: { contains: query.search, mode: "insensitive" } } } },
    ];
  }
  return paginated(prisma.cashMovement, {
    where,
    include: {
      branch: { select: { id: true, name: true, code: true } },
      order: { select: { id: true, orderNumber: true, clientName: true } },
      createdBy: { select: { id: true, name: true, login: true } },
    },
    orderBy: { createdAt: "desc" },
    query,
  });
};

module.exports = { findOpenShift, createCashMovement, listCashMovements };
