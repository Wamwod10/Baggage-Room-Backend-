const prisma = require("../config/prisma");
const { branchWhere, getScopedBranchId } = require("../utils/scope");
const { dateRangeWhere, startOfToday } = require("../utils/date");
const { sum, byKeySum } = require("../utils/money");
const { markDelayedOrders } = require("./order.service");

const asNumber = (value) => Number(value || 0);
const dayKey = (date) => date.toISOString().slice(0, 10);
const branchName = (item) => item.branch?.name || item.branchId || "Unknown";
const userName = (user) => user?.name || user?.login || "Unknown";

const countBy = (items, keySelector) =>
  items.reduce((acc, item) => {
    const key = keySelector(item) || "UNKNOWN";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

const percent = (part, total) => (total > 0 ? Math.round((part / total) * 100) : 0);

const buildBranchSummary = ({ branches, orders, lockers, movements }) =>
  branches.map((branch) => {
    const branchOrders = orders.filter((order) => order.branchId === branch.id);
    const branchLockers = lockers.filter((locker) => locker.branchId === branch.id);
    const branchIn = movements.filter((movement) => movement.branchId === branch.id && movement.direction === "IN");
    const branchExpenses = movements.filter(
      (movement) => movement.branchId === branch.id && movement.direction === "OUT" && movement.type === "EXPENSE",
    );

    const revenue = sum(branchIn);
    const expenseAmount = sum(branchExpenses);

    return {
      id: branch.id,
      name: branch.name,
      code: branch.code,
      lockers: branchLockers.length,
      orders: branchOrders.length,
      totalOrders: branchOrders.length,
      activeOrders: branchOrders.filter((order) => ["ACTIVE", "DELAYED"].includes(order.status)).length,
      delayedOrders: branchOrders.filter((order) => order.status === "DELAYED").length,
      cancelledOrders: branchOrders.filter((order) => order.status === "CANCELLED").length,
      emptyLockers: branchLockers.filter((locker) => locker.status === "EMPTY").length,
      busyLockers: branchLockers.filter((locker) => locker.status === "BUSY").length,
      revenue,
      netProfit: revenue - expenseAmount,
    };
  });

const dashboard = async (user, query) => {
  const scopedBranchId = getScopedBranchId(user, query.branchId);
  await markDelayedOrders(scopedBranchId);
  const scope = scopedBranchId ? { branchId: scopedBranchId } : {};
  const branchScope = scopedBranchId ? { id: scopedBranchId } : {};
  const today = startOfToday();
  const [
    todayMovements,
    activeOrders,
    totalOrders,
    todayClients,
    openDebts,
    lockers,
    delayedOrders,
    cancelledOrders,
    inkassa,
    shifts,
    branches,
    todayOrders,
  ] = await Promise.all([
    prisma.cashMovement.findMany({ where: { ...scope, createdAt: { gte: today } } }),
    prisma.order.count({ where: { ...scope, status: { in: ["ACTIVE", "DELAYED"] } } }),
    prisma.order.count({ where: scope }),
    prisma.order.count({ where: { ...scope, createdAt: { gte: today } } }),
    prisma.debt.findMany({ where: { ...scope, status: "OPEN" } }),
    prisma.locker.findMany({ where: scope, include: { branch: { select: { id: true, name: true, code: true } } } }),
    prisma.order.count({ where: { ...scope, status: "DELAYED" } }),
    prisma.order.count({ where: { ...scope, status: "CANCELLED" } }),
    prisma.inkassa.findMany({ where: { ...scope, createdAt: { gte: today } } }),
    prisma.shift.findMany({ where: { ...scope, status: "OPEN" }, include: { branch: { select: { id: true, name: true } } } }),
    prisma.branch.findMany({ where: branchScope, orderBy: { name: "asc" } }),
    prisma.order.findMany({ where: { ...scope, createdAt: { gte: today } }, select: { id: true, branchId: true, status: true } }),
  ]);

  const todayPayments = todayMovements.filter((movement) => movement.direction === "IN");
  const todayOut = todayMovements.filter((movement) => movement.direction === "OUT");
  const todayExpenses = todayOut.filter((movement) => movement.type === "EXPENSE");
  const todayInkassa = todayOut.filter((movement) => movement.type === "INKASSA");
  const lockerCounts = countBy(lockers, (item) => item.status);
  const todayRevenue = sum(todayPayments);
  const expenseAmount = sum(todayExpenses);
  const cashMovementIn = todayRevenue;
  const cashMovementOut = sum(todayOut);

  return {
    todayRevenue,
    totalRevenue: todayRevenue,
    revenue: todayRevenue,
    activeOrders,
    totalOrders,
    todayOrders: todayClients,
    todayClients,
    netProfit: todayRevenue - expenseAmount,
    expenseAmount,
    totalExpenses: expenseAmount,
    debtAmount: sum(openDebts),
    openDebtAmount: sum(openDebts),
    emptyLockers: lockerCounts.EMPTY || 0,
    busyLockers: lockerCounts.BUSY || 0,
    delayedOrders,
    cancelledOrders,
    inkassaAmount: sum(inkassa) || sum(todayInkassa),
    cashMovementIn,
    cashMovementOut,
    paymentBreakdown: byKeySum(todayPayments, "paymentType"),
    currencyBreakdown: byKeySum(todayPayments, "currency"),
    branchSummary: buildBranchSummary({ branches, orders: todayOrders, lockers, movements: todayMovements }),
    shiftStatus: shifts,
  };
};

const reports = async (user, query) => {
  const scope = branchWhere(user, query.branchId);
  const range = dateRangeWhere(query.dateFrom, query.dateTo);
  const shiftRange = dateRangeWhere(query.dateFrom, query.dateTo, "openedAt");
  const [movements, orders, lockers, debts, auditLogs, shifts, expenses, inkassa, branches] = await Promise.all([
    prisma.cashMovement.findMany({ where: { ...scope, ...range }, include: { branch: true, createdBy: { select: { id: true, name: true, login: true } } } }),
    prisma.order.findMany({
      where: { ...scope, ...range },
      include: { branch: true, items: true, createdBy: { select: { id: true, name: true, login: true } } },
    }),
    prisma.locker.findMany({ where: scope, include: { branch: true } }),
    prisma.debt.findMany({ where: { ...scope, ...range } }),
    prisma.auditLog.findMany({ where: { ...scope, ...range }, include: { user: { select: { id: true, name: true, login: true } } }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.shift.findMany({
      where: { ...scope, ...shiftRange },
      include: { branch: true, openedBy: { select: { id: true, name: true, login: true } } },
      orderBy: { openedAt: "desc" },
    }),
    prisma.expense.findMany({ where: { ...scope, ...range }, include: { branch: true, createdBy: { select: { id: true, name: true, login: true } } } }),
    prisma.inkassa.findMany({ where: { ...scope, ...range }, include: { branch: true, createdBy: { select: { id: true, name: true, login: true } } } }),
    prisma.branch.findMany({ where: scope.branchId ? { id: scope.branchId } : {}, orderBy: { name: "asc" } }),
  ]);

  const inMovements = movements.filter((m) => m.direction === "IN");
  const outMovements = movements.filter((m) => m.direction === "OUT");
  const expenseMovements = outMovements.filter((m) => m.type === "EXPENSE");
  const inkassaMovements = outMovements.filter((m) => m.type === "INKASSA");
  const totalRevenue = sum(inMovements);
  const totalExpenses = sum(expenseMovements) || sum(expenses);
  const totalInkassa = sum(inkassaMovements) || sum(inkassa);
  const totalOrders = orders.length;

  const revenueByDay = {};
  const expensesByDay = {};
  const ordersByDay = {};
  for (const item of inMovements) {
    const day = dayKey(item.createdAt);
    revenueByDay[day] = (revenueByDay[day] || 0) + item.amount;
  }
  for (const item of expenseMovements.length ? expenseMovements : expenses) {
    const day = dayKey(item.createdAt);
    expensesByDay[day] = (expensesByDay[day] || 0) + item.amount;
  }
  for (const order of orders) {
    const day = dayKey(order.createdAt);
    ordersByDay[day] = (ordersByDay[day] || 0) + 1;
  }

  const peakHours = {};
  for (const order of orders) {
    const hour = order.createdAt.getHours();
    peakHours[hour] = (peakHours[hour] || 0) + 1;
  }

  const branchComparison = branches.map((branch) => {
    const branchOrders = orders.filter((order) => order.branchId === branch.id);
    const branchRevenue = sum(inMovements.filter((item) => item.branchId === branch.id));
    const branchExpenses = sum(expenseMovements.filter((item) => item.branchId === branch.id));
    const delayed = branchOrders.filter((order) => order.status === "DELAYED").length;
    const cancelled = branchOrders.filter((order) => order.status === "CANCELLED").length;

    return {
      branch: branch.name,
      revenue: branchRevenue,
      profit: branchRevenue - branchExpenses,
      orders: branchOrders.length,
      active: branchOrders.filter((order) => ["ACTIVE", "DELAYED"].includes(order.status)).length,
      delayed,
      cancelled,
      score: Math.max(0, 100 - delayed * 5 - cancelled * 10),
    };
  });

  const sizeAnalytics = Object.values(
    orders.reduce((acc, order) => {
      for (const item of order.items || []) {
        const key = item.size || "UNKNOWN";
        if (!acc[key]) acc[key] = { size: key, orders: 0, count: 0, amount: 0 };
        acc[key].orders += 1;
        acc[key].count += 1;
        acc[key].amount += asNumber(item.finalPrice);
      }
      return acc;
    }, {}),
  );

  const adminPerformanceMap = {};
  for (const order of orders) {
    const key = userName(order.createdBy);
    if (!adminPerformanceMap[key]) adminPerformanceMap[key] = { admin: key, orders: 0, revenue: 0, profit: 0, shifts: 0 };
    adminPerformanceMap[key].orders += 1;
    adminPerformanceMap[key].revenue += asNumber(order.realPaidAmount);
  }
  for (const shift of shifts) {
    const key = userName(shift.openedBy);
    if (!adminPerformanceMap[key]) adminPerformanceMap[key] = { admin: key, orders: 0, revenue: 0, profit: 0, shifts: 0 };
    adminPerformanceMap[key].shifts += 1;
    adminPerformanceMap[key].revenue += asNumber(shift.totalRevenue);
    adminPerformanceMap[key].profit += asNumber(shift.totalRevenue) - asNumber(shift.expenseAmount);
  }

  const shiftRevenueTotal = sum(shifts, (shift) => shift.totalRevenue);
  const bestShift = shifts
    .slice()
    .sort((a, b) => asNumber(b.totalRevenue) - asNumber(a.totalRevenue))[0];

  return {
    orderStats: {
      totalOrders,
      activeOrders: orders.filter((order) => ["ACTIVE", "DELAYED"].includes(order.status)).length,
      delayedOrders: orders.filter((order) => order.status === "DELAYED").length,
      cancelledOrders: orders.filter((order) => order.status === "CANCELLED").length,
      pickedUpOrders: orders.filter((order) => order.status === "PICKED_UP").length,
    },
    financeAnalytics: {
      revenue: totalRevenue,
      totalExpenses,
      netProfit: totalRevenue - totalExpenses,
      profitMargin: percent(totalRevenue - totalExpenses, totalRevenue),
      averageOrder: totalOrders ? Math.round(totalRevenue / totalOrders) : 0,
      averageShiftRevenue: shifts.length ? Math.round(shiftRevenueTotal / shifts.length) : 0,
      expenseRatio: percent(totalExpenses, totalRevenue),
      inkassa: totalInkassa,
    },
    revenueByDay,
    expensesByDay,
    ordersByDay,
    revenueByBranch: movements.filter((m) => m.direction === "IN").reduce((acc, item) => {
      const name = branchName(item);
      acc[name] = (acc[name] || 0) + item.amount;
      return acc;
    }, {}),
    branchComparison,
    revenueByCurrency: byKeySum(movements.filter((m) => m.direction === "IN"), "currency"),
    paymentAnalytics: byKeySum(movements.filter((m) => m.direction === "IN"), "paymentType"),
    paymentOrderCounts: countBy(inMovements, (item) => item.paymentType),
    lockerUsage: lockers.reduce((acc, locker) => {
      const key = locker.status;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    debtAnalytics: { open: sum(debts.filter((d) => d.status === "OPEN")), closed: sum(debts.filter((d) => d.status === "CLOSED")) },
    expenseCategories: Object.values(expenses.reduce((acc, expense) => {
      const key = expense.category || "Other";
      if (!acc[key]) acc[key] = { category: key, amount: 0, count: 0 };
      acc[key].amount += asNumber(expense.amount);
      acc[key].count += 1;
      return acc;
    }, {})),
    baggageSizeAnalytics: sizeAnalytics,
    adminPerformance: Object.values(adminPerformanceMap).map((admin) => ({
      ...admin,
      profit: admin.profit || admin.revenue,
    })),
    shiftAnalytics: {
      total: shifts.length,
      open: shifts.filter((shift) => shift.status === "OPEN").length,
      closed: shifts.filter((shift) => shift.status === "CLOSED").length,
      twelveHour: shifts.filter((shift) => String(shift.shiftTime || "").includes("12")).length,
      twentyFourHour: shifts.filter((shift) => String(shift.shiftTime || "").includes("24")).length,
      averageRevenue: shifts.length ? Math.round(shiftRevenueTotal / shifts.length) : 0,
      bestShift: bestShift
        ? {
            id: bestShift.id,
            branch: bestShift.branch?.name || bestShift.branchId,
            admin: userName(bestShift.openedBy),
            shiftTime: bestShift.shiftTime || "",
            totalRevenue: bestShift.totalRevenue,
            analyticsRevenue: bestShift.totalRevenue,
          }
        : null,
    },
    cashMovementAnalytics: {
      in: sum(inMovements),
      out: sum(outMovements),
      expense: totalExpenses,
      inkassa: totalInkassa,
    },
    branchRanking: branchComparison.slice().sort((a, b) => b.score - a.score || b.revenue - a.revenue),
    cashMovement: movements,
    expenses,
    inkassa,
    shifts,
    peakHours,
    adminActivity: auditLogs,
  };
};

module.exports = { dashboard, reports };
