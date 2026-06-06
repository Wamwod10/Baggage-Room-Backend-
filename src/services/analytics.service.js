const prisma = require("../config/prisma");
const { branchWhere, getScopedBranchId } = require("../utils/scope");
const { dateRangeWhere, startOfToday } = require("../utils/date");
const { sum, byKeySum } = require("../utils/money");
const { markDelayedOrders } = require("./order.service");

const dashboard = async (user, query) => {
  const scopedBranchId = getScopedBranchId(user, query.branchId);
  await markDelayedOrders(scopedBranchId);
  const scope = scopedBranchId ? { branchId: scopedBranchId } : {};
  const branchScope = scopedBranchId ? { id: scopedBranchId } : {};
  const today = startOfToday();
  const [todayPayments, activeOrders, todayClients, openDebts, lockers, delayedOrders, inkassa, shifts, branches] = await Promise.all([
    prisma.cashMovement.findMany({ where: { ...scope, direction: "IN", createdAt: { gte: today } } }),
    prisma.order.count({ where: { ...scope, status: { in: ["ACTIVE", "DELAYED"] } } }),
    prisma.order.count({ where: { ...scope, createdAt: { gte: today } } }),
    prisma.debt.findMany({ where: { ...scope, status: "OPEN" } }),
    prisma.locker.groupBy({ by: ["status"], where: scope, _count: { _all: true } }),
    prisma.order.count({ where: { ...scope, status: "DELAYED" } }),
    prisma.inkassa.findMany({ where: { ...scope, createdAt: { gte: today } } }),
    prisma.shift.findMany({ where: { ...scope, status: "OPEN" }, include: { branch: { select: { id: true, name: true } } } }),
    prisma.branch.findMany({ where: branchScope, include: { _count: { select: { lockers: true, orders: true } } }, orderBy: { name: "asc" } }),
  ]);

  const lockerCounts = Object.fromEntries(lockers.map((item) => [item.status, item._count._all]));
  const todayRevenue = sum(todayPayments);
  const expenseAmount = sum(await prisma.cashMovement.findMany({ where: { ...scope, direction: "OUT", type: "EXPENSE", createdAt: { gte: today } } }));

  return {
    todayRevenue,
    activeOrders,
    todayClients,
    netProfit: todayRevenue - expenseAmount,
    debtAmount: sum(openDebts),
    emptyLockers: lockerCounts.EMPTY || 0,
    busyLockers: lockerCounts.BUSY || 0,
    delayedOrders,
    inkassaAmount: sum(inkassa),
    paymentBreakdown: byKeySum(todayPayments, "paymentType"),
    currencyBreakdown: byKeySum(todayPayments, "currency"),
    branchSummary: branches.map((branch) => ({ id: branch.id, name: branch.name, code: branch.code, lockers: branch._count.lockers, orders: branch._count.orders })),
    shiftStatus: shifts,
  };
};

const reports = async (user, query) => {
  const scope = branchWhere(user, query.branchId);
  const range = dateRangeWhere(query.dateFrom, query.dateTo);
  const [movements, orders, lockers, debts, auditLogs] = await Promise.all([
    prisma.cashMovement.findMany({ where: { ...scope, ...range }, include: { branch: true } }),
    prisma.order.findMany({ where: { ...scope, ...range }, include: { branch: true, items: true } }),
    prisma.locker.findMany({ where: scope, include: { branch: true } }),
    prisma.debt.findMany({ where: { ...scope, ...range } }),
    prisma.auditLog.findMany({ where: { ...scope, ...range }, include: { user: { select: { id: true, name: true, login: true } } }, orderBy: { createdAt: "desc" }, take: 200 }),
  ]);

  const revenueByDay = {};
  for (const item of movements.filter((m) => m.direction === "IN")) {
    const day = item.createdAt.toISOString().slice(0, 10);
    revenueByDay[day] = (revenueByDay[day] || 0) + item.amount;
  }

  const peakHours = {};
  for (const order of orders) {
    const hour = order.createdAt.getHours();
    peakHours[hour] = (peakHours[hour] || 0) + 1;
  }

  return {
    revenueByDay,
    revenueByBranch: movements.filter((m) => m.direction === "IN").reduce((acc, item) => {
      const name = item.branch?.name || item.branchId;
      acc[name] = (acc[name] || 0) + item.amount;
      return acc;
    }, {}),
    revenueByCurrency: byKeySum(movements.filter((m) => m.direction === "IN"), "currency"),
    paymentAnalytics: byKeySum(movements.filter((m) => m.direction === "IN"), "paymentType"),
    lockerUsage: lockers.reduce((acc, locker) => {
      const key = `${locker.branch.name}:${locker.status}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    debtAnalytics: { open: sum(debts.filter((d) => d.status === "OPEN")), closed: sum(debts.filter((d) => d.status === "CLOSED")) },
    cashMovement: movements,
    peakHours,
    adminActivity: auditLogs,
  };
};

module.exports = { dashboard, reports };
