const prisma = require("../config/prisma");
const { branchWhere, getScopedBranchId } = require("../utils/scope");
const { dateRangeWhere, formatTashkentDateKey, startOfToday } = require("../utils/date");
const { sum, byKeySum, byCurrency, subtractCurrencyMaps } = require("../utils/money");
const { normalizeCurrencyMap } = require("./shift.service");
const { summarizeMovements, sumCurrencyMaps, cashBalanceByCurrency } = require("./cashAccounting.service");
const { loadCombinedOrderFacts } = require("../repositories/orderAnalytics.repository");
const { loadMovementFacts } = require("../repositories/cashMovementAnalytics.repository");
const { createTimer } = require("../utils/perf");
const {
  buildAnalyticsCacheKey,
  getCachedAnalytics,
  setCachedAnalytics,
} = require("./analyticsCache");

const asNumber = (value) => Number(value || 0);
const dayKey = (date) => formatTashkentDateKey(date);
const branchName = (item) => item.branch?.name || item.branchId || "Unknown";
const userName = (user) => user?.name || user?.login || "Unknown";

const countBy = (items, keySelector, weightSelector = () => 1) =>
  items.reduce((acc, item) => {
    const key = keySelector(item) || "UNKNOWN";
    acc[key] = (acc[key] || 0) + Number(weightSelector(item) || 0);
    return acc;
  }, {});

const percent = (part, total) => (total > 0 ? Math.round((part / total) * 100) : 0);
const currencies = ["UZS", "USD", "RUB", "EUR", "KZT", "TJS"];
const paymentCurrencyBreakdown = (movements = []) =>
  ["CASH", "TERMINAL", "CLICK", "PAYME", "DEBT"].reduce((result, paymentType) => {
    const aliases = paymentType === "TERMINAL" ? ["TERMINAL", "CARD", "TRANSFER"] : [paymentType];
    result[paymentType] = byCurrency(movements.filter((item) => aliases.includes(item.paymentType)));
    return result;
  }, {});

const groupByValue = (items, keySelector) =>
  items.reduce((acc, item) => {
    const key = keySelector(item);
    if (!key) return acc;
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});

const isBetweenDates = (value, start, end) => {
  const time = new Date(value).getTime();
  return time >= new Date(start).getTime() && time <= new Date(end).getTime();
};

const buildShiftReports = ({ shifts, movements, debts, orders, now = new Date() }) => {
  const movementsByShiftId = groupByValue(movements, (item) => item.shiftId);

  return shifts.map((shift) => {
    const reportEnd = shift.closedAt || now;
    const shiftDebts = debts.filter(
      (item) =>
        item.branchId === shift.branchId &&
        isBetweenDates(item.createdAt, shift.openedAt, reportEnd),
    );
    const openDebts = shiftDebts.filter((item) => item.status === "OPEN");
    const ordersCount = orders.filter(
      (item) =>
        item.branchId === shift.branchId &&
        isBetweenDates(item.createdAt, shift.openedAt, reportEnd),
    ).length;

    const summary = summarizeMovements(movementsByShiftId[shift.id] || []);
    const salaryMovements = summary.groups.expenses.filter((movement) =>
      movement.type === "EXPENSE" && String(movement.note || "").startsWith("Oylik:"),
    );
    const revenueByCurrency = summary.revenueByCurrency;
    const cashByCurrency = summary.cashByCurrency;
    const terminalByCurrency = summary.terminalByCurrency;
    const clickByCurrency = summary.clickByCurrency;
    const paymeByCurrency = summary.paymeByCurrency;
    const expenseByCurrency = summary.expenseByCurrency;
    const salaryByCurrency = byCurrency(salaryMovements);
    const inkassaByCurrency = summary.inkassaByCurrency;
    const debtByCurrency = byCurrency(openDebts);
    const openingCashByCurrency = normalizeCurrencyMap(shift.openingCashByCurrency, shift.openingCash);
    const acceptedCashByCurrency = normalizeCurrencyMap(shift.acceptedCashByCurrency, shift.acceptedCash);
    const balanceByCurrency = cashBalanceByCurrency({
      openingCashByCurrency,
      acceptedCashByCurrency,
      cashRevenueByCurrency: cashByCurrency,
      expenseByCurrency,
      inkassaByCurrency,
      manualInByCurrency: summary.manualInByCurrency,
      manualOutByCurrency: summary.manualOutByCurrency,
    });
    const totalRevenue = revenueByCurrency.UZS;
    const terminalRevenue = terminalByCurrency.UZS;

    return {
      ...shift,
      totalRevenue,
      cashRevenue: cashByCurrency.UZS,
      cardRevenue: terminalRevenue,
      terminalRevenue,
      clickRevenue: clickByCurrency.UZS,
      paymeRevenue: paymeByCurrency.UZS,
      transferRevenue: summary.transferByCurrency.UZS,
      debtAmount: debtByCurrency.UZS,
      expenseAmount: expenseByCurrency.UZS,
      salaryAmount: salaryByCurrency.UZS,
      inkassaAmount: inkassaByCurrency.UZS,
      systemExpectedCash: balanceByCurrency.UZS,
      ordersCount,
      openingCashByCurrency,
      acceptedCashByCurrency,
      revenueByCurrency,
      cashByCurrency,
      terminalByCurrency,
      clickByCurrency,
      paymeByCurrency,
      expenseByCurrency,
      salaryByCurrency,
      inkassaByCurrency,
      debtByCurrency,
      cashBalanceByCurrency: balanceByCurrency,
      paymentByCurrency: {
        CASH: cashByCurrency,
        TERMINAL: terminalByCurrency,
        CLICK: clickByCurrency,
        PAYME: paymeByCurrency,
      },
    };
  });
};

const buildBranchSummary = ({ branches, orders = [], branchOrderStats = null, lockers, movements }) =>
  branches.map((branch) => {
    const branchOrders = orders.filter((order) => order.branchId === branch.id);
    const orderStats = branchOrderStats?.[branch.id] || {
      orders: branchOrders.length,
      active: branchOrders.filter((order) => ["ACTIVE", "DELAYED"].includes(order.status)).length,
      delayed: branchOrders.filter((order) => order.status === "DELAYED").length,
      cancelled: branchOrders.filter((order) => order.status === "CANCELLED").length,
    };
    const branchLockers = lockers.filter((locker) => locker.branchId === branch.id);
    const branchSummary = summarizeMovements(movements.filter((movement) => movement.branchId === branch.id));
    const revenue = sum(branchSummary.groups.revenueIn);
    const expenseAmount = sum(branchSummary.groups.expenses);
    const inkassaAmount = sum(branchSummary.groups.inkassa);

    return {
      id: branch.id,
      name: branch.name,
      code: branch.code,
      lockers: branchLockers.length,
      orders: orderStats.orders,
      totalOrders: orderStats.orders,
      activeOrders: orderStats.active,
      delayedOrders: orderStats.delayed,
      cancelledOrders: orderStats.cancelled,
      emptyLockers: branchLockers.filter((locker) => locker.status === "EMPTY").length,
      busyLockers: branchLockers.filter((locker) => locker.status === "BUSY").length,
      revenue,
      netProfit: revenue - expenseAmount - inkassaAmount,
      cashOnHand: revenue - expenseAmount - inkassaAmount,
    };
  });

const buildOrderAnalyticsFromFacts = ({ rows = [], total = {} } = {}, branches = []) => {
  const statusCounts = total.statusCounts || {};
  const ordersByDay = {};
  const peakHours = {};
  const branchOrderStats = Object.fromEntries(branches.map((branch) => [branch.id, {
    orders: 0,
    active: 0,
    delayed: 0,
    cancelled: 0,
  }]));

  for (const row of rows) {
    ordersByDay[row.day] = (ordersByDay[row.day] || 0) + asNumber(row.totalOrders);
    for (const [hour, count] of Object.entries(row.hourCounts || {})) {
      peakHours[hour] = (peakHours[hour] || 0) + asNumber(count);
    }
    const current = branchOrderStats[row.branchId] || { orders: 0, active: 0, delayed: 0, cancelled: 0 };
    current.orders += asNumber(row.totalOrders);
    current.active += asNumber(row.statusCounts?.ACTIVE) + asNumber(row.statusCounts?.DELAYED);
    current.delayed += asNumber(row.statusCounts?.DELAYED);
    current.cancelled += asNumber(row.statusCounts?.CANCELLED);
    branchOrderStats[row.branchId] = current;
  }

  const debtByCurrency = Object.fromEntries(currencies.map((currency) => [currency, 0]));
  let openDebt = 0;
  let closedDebt = 0;
  for (const [status, byCurrencyStats] of Object.entries(total.debtStats || {})) {
    for (const [currency, stats] of Object.entries(byCurrencyStats || {})) {
      const amount = asNumber(stats?.amount);
      if (status === "OPEN") {
        openDebt += amount;
        debtByCurrency[currency] = asNumber(debtByCurrency[currency]) + amount;
      }
      if (status === "CLOSED") closedDebt += amount;
    }
  }

  return {
    orderStats: {
      totalOrders: asNumber(total.totalOrders),
      activeOrders: asNumber(statusCounts.ACTIVE) + asNumber(statusCounts.DELAYED),
      delayedOrders: asNumber(statusCounts.DELAYED),
      cancelledOrders: asNumber(statusCounts.CANCELLED),
      pickedUpOrders: asNumber(statusCounts.PICKED_UP),
    },
    ordersByDay,
    peakHours,
    branchOrderStats,
    baggageSizeAnalytics: Object.entries(total.sizeStats || {}).map(([size, stats]) => ({
      size,
      orders: asNumber(stats?.orders),
      count: asNumber(stats?.count),
      amount: asNumber(stats?.amount),
    })),
    debtAnalytics: { open: openDebt, closed: closedDebt },
    debtByCurrency,
  };
};

const mergeOrderAnalyticsIntoReport = (report, orderAnalytics) => ({
  ...report,
  orderStats: orderAnalytics.orderStats,
  ordersByDay: orderAnalytics.ordersByDay,
  peakHours: orderAnalytics.peakHours,
  baggageSizeAnalytics: orderAnalytics.baggageSizeAnalytics,
  debtAnalytics: orderAnalytics.debtAnalytics,
});

const dashboardUncached = async (user, query) => {
  const timer = createTimer("analytics.dashboard");
  const scopedBranchId = getScopedBranchId(user, query.branchId);
  const scope = scopedBranchId ? { branchId: scopedBranchId } : {};
  const branchScope = scopedBranchId ? { id: scopedBranchId } : {};
  const today = startOfToday();
  const todayKey = dayKey(today);
  const [
    todayMovements,
    allOrderFacts,
    openDebts,
    lockers,
    shifts,
    branches,
    todayOrderFacts,
  ] = await Promise.all([
    prisma.cashMovement.findMany({
      where: { ...scope, createdAt: { gte: today } },
      select: { branchId: true, type: true, direction: true, amount: true, currency: true, paymentType: true, createdAt: true },
    }),
    loadCombinedOrderFacts({ branchId: scopedBranchId }, prisma, timer),
    prisma.debt.findMany({ where: { ...scope, status: "OPEN" }, select: { amount: true, currency: true } }),
    prisma.locker.findMany({ where: scope, select: { branchId: true, status: true } }),
    prisma.shift.findMany({ where: { ...scope, status: "OPEN" }, include: { branch: { select: { id: true, name: true } } } }),
    prisma.branch.findMany({ where: branchScope, orderBy: { name: "asc" } }),
    loadCombinedOrderFacts({ branchId: scopedBranchId, dateFrom: todayKey, dateTo: todayKey }, prisma),
  ]);

  const allOrderAnalytics = buildOrderAnalyticsFromFacts(allOrderFacts, branches);
  const todayOrderAnalytics = buildOrderAnalyticsFromFacts(todayOrderFacts, branches);
  const activeOrders = allOrderAnalytics.orderStats.activeOrders;
  const totalOrders = allOrderAnalytics.orderStats.totalOrders;
  const todayClients = todayOrderAnalytics.orderStats.totalOrders;
  const delayedOrders = allOrderAnalytics.orderStats.delayedOrders;
  const cancelledOrders = allOrderAnalytics.orderStats.cancelledOrders;
  let shiftStatus = [];
  if (shifts.length) {
    const shiftIds = shifts.map((shift) => shift.id);
    const branchIds = [...new Set(shifts.map((shift) => shift.branchId))];
    const earliestOpen = shifts.reduce((earliest, shift) => shift.openedAt < earliest ? shift.openedAt : earliest, shifts[0].openedAt);
    const [shiftMovements, shiftDebts, shiftOrders] = await Promise.all([
      prisma.cashMovement.findMany({ where: { shiftId: { in: shiftIds } } }),
      prisma.debt.findMany({ where: { branchId: { in: branchIds }, createdAt: { gte: earliestOpen } }, select: { branchId: true, amount: true, currency: true, status: true, createdAt: true } }),
      prisma.order.findMany({ where: { branchId: { in: branchIds }, createdAt: { gte: earliestOpen } }, select: { branchId: true, createdAt: true } }),
    ]);
    shiftStatus = buildShiftReports({ shifts, movements: shiftMovements, debts: shiftDebts, orders: shiftOrders });
  }
  const todaySummary = summarizeMovements(todayMovements);
  const todayPayments = todaySummary.groups.revenueIn;
  const todayOut = todaySummary.groups.balanceOut;
  const lockerCounts = countBy(lockers, (item) => item.status);
  const revenueByCurrency = todaySummary.revenueByCurrency;
  const expensesByCurrency = todaySummary.expenseByCurrency;
  const inkassaByCurrency = todaySummary.inkassaByCurrency;
  const debtByCurrency = byCurrency(openDebts);
  const cashOnHandByCurrency = sumCurrencyMaps(shiftStatus.map((shift) => shift.cashBalanceByCurrency));
  const netProfitByCurrency = subtractCurrencyMaps(revenueByCurrency, expensesByCurrency, inkassaByCurrency);
  const todayRevenue = revenueByCurrency.UZS;
  const expenseAmount = expensesByCurrency.UZS;
  const inkassaAmount = inkassaByCurrency.UZS;
  const cashMovementIn = todayRevenue;
  const cashMovementOut = byCurrency(todayOut).UZS;
  const cashOnHand = cashOnHandByCurrency.UZS;

  const result = {
    todayRevenue,
    totalRevenue: todayRevenue,
    revenue: todayRevenue,
    activeOrders,
    totalOrders,
    todayOrders: todayClients,
    todayClients,
    netProfit: todayRevenue - expenseAmount - inkassaAmount,
    cashOnHand,
    cashLeft: cashOnHand,
    expenseAmount,
    totalExpenses: expenseAmount,
    debtAmount: debtByCurrency.UZS,
    openDebtAmount: debtByCurrency.UZS,
    emptyLockers: lockerCounts.EMPTY || 0,
    busyLockers: lockerCounts.BUSY || 0,
    delayedOrders,
    cancelledOrders,
    inkassaAmount,
    cashMovementIn,
    cashMovementOut,
    paymentBreakdown: byKeySum(todayPayments.filter((item) => item.currency === "UZS"), "paymentType"),
    paymentCurrencyBreakdown: paymentCurrencyBreakdown(todayPayments),
    currencyBreakdown: revenueByCurrency,
    revenueByCurrency,
    expensesByCurrency,
    inkassaByCurrency,
    debtByCurrency,
    cashOnHandByCurrency,
    netProfitByCurrency,
    branchSummary: buildBranchSummary({ branches, branchOrderStats: todayOrderAnalytics.branchOrderStats, lockers, movements: todayMovements }),
    shiftStatus,
  };
  timer.end({ rows: allOrderFacts.rows.length });
  return result;
};

const reportsUncached = async (user, query) => {
  const timer = createTimer("analytics.reports");
  const scope = branchWhere(user, query.branchId);
  const range = dateRangeWhere(query.dateFrom, query.dateTo);
  const shiftRange = dateRangeWhere(query.dateFrom, query.dateTo, "openedAt");
  const [movementFacts, orderFacts, lockers, debts, auditLogs, shifts, expenses, inkassa, branches, users] = await Promise.all([
    loadMovementFacts({ branchId: scope.branchId, dateFrom: query.dateFrom, dateTo: query.dateTo }, prisma),
    loadCombinedOrderFacts({ branchId: scope.branchId, dateFrom: query.dateFrom, dateTo: query.dateTo }, prisma, timer),
    prisma.locker.findMany({ where: scope, select: { id: true, branchId: true, status: true } }),
    prisma.debt.findMany({ where: { ...scope, ...range }, select: { branchId: true, amount: true, currency: true, status: true, createdAt: true } }),
    Promise.resolve([]),
    prisma.shift.findMany({
      where: { ...scope, ...shiftRange },
      select: {
        id: true,
        branchId: true,
        openedById: true,
        openingCash: true,
        acceptedCash: true,
        openingCashByCurrency: true,
        acceptedCashByCurrency: true,
        openedAt: true,
        closedAt: true,
        status: true,
        branch: { select: { id: true, name: true, code: true } },
        openedBy: { select: { id: true, name: true, login: true } },
      },
      orderBy: { openedAt: "desc" },
    }),
    prisma.expense.findMany({ where: { ...scope, ...range }, select: { id: true, branchId: true, category: true, amount: true, currency: true, createdAt: true } }),
    prisma.inkassa.findMany({ where: { ...scope, ...range }, select: { id: true, branchId: true, amount: true, currency: true, createdAt: true } }),
    prisma.branch.findMany({ where: scope.branchId ? { id: scope.branchId } : {}, select: { id: true, name: true, code: true }, orderBy: { name: "asc" } }),
    prisma.user.findMany({ select: { id: true, name: true, login: true } }),
  ]);
  const orderAnalytics = buildOrderAnalyticsFromFacts(orderFacts, branches);
  const branchById = new Map(branches.map((branch) => [branch.id, branch]));
  const userById = new Map(users.map((item) => [item.id, item]));
  const movements = movementFacts.map((movement) => ({
    ...movement,
    note: movement.isSalary ? "Oylik:" : null,
    createdAt: new Date(`${movement.day}T00:00:00+05:00`),
    branch: branchById.get(movement.branchId),
    createdBy: userById.get(movement.createdById),
  }));

  const reportNow = new Date();
  const shiftIds = shifts.map((shift) => shift.id);
  let shiftsWithReports = [];

  if (shiftIds.length) {
    const shiftIdSet = new Set(shiftIds);

    shiftsWithReports = buildShiftReports({
      shifts,
      movements: movements.filter((movement) => shiftIdSet.has(movement.shiftId)),
      debts,
      orders: [],
      now: reportNow,
    });
  }

  const movementSummary = summarizeMovements(movements);
  const inMovements = movementSummary.groups.revenueIn;
  const outMovements = movementSummary.groups.balanceOut;
  const expenseMovements = movementSummary.groups.expenses;
  const inkassaMovements = movementSummary.groups.inkassa;
  const revenueByCurrency = movementSummary.revenueByCurrency;
  const expensesByCurrency = byCurrency(expenseMovements.length ? expenseMovements : expenses);
  const inkassaByCurrency = byCurrency(inkassaMovements.length ? inkassaMovements : inkassa);
  const debtByCurrency = orderAnalytics.debtByCurrency;
  const cashOnHandByCurrency = shiftsWithReports.length
    ? sumCurrencyMaps(shiftsWithReports.map((shift) => shift.cashBalanceByCurrency))
    : subtractCurrencyMaps(revenueByCurrency, expensesByCurrency, inkassaByCurrency);
  const netProfitByCurrency = subtractCurrencyMaps(revenueByCurrency, expensesByCurrency, inkassaByCurrency);
  const totalRevenue = revenueByCurrency.UZS;
  const totalExpenses = expensesByCurrency.UZS;
  const totalInkassa = inkassaByCurrency.UZS;
  const totalOrders = orderAnalytics.orderStats.totalOrders;

  const revenueByDay = {};
  const expensesByDay = {};
  const inkassaByDay = {};
  const ordersByDay = orderAnalytics.ordersByDay;
  for (const item of inMovements) {
    const day = dayKey(item.createdAt);
    revenueByDay[day] = (revenueByDay[day] || 0) + item.amount;
  }
  for (const item of expenseMovements.length ? expenseMovements : expenses) {
    const day = dayKey(item.createdAt);
    expensesByDay[day] = (expensesByDay[day] || 0) + item.amount;
  }
  for (const item of inkassaMovements.length ? inkassaMovements : inkassa) {
    const day = dayKey(item.createdAt);
    inkassaByDay[day] = (inkassaByDay[day] || 0) + item.amount;
  }
  const peakHours = orderAnalytics.peakHours;

  const branchComparison = branches.map((branch) => {
    const branchOrders = orderAnalytics.branchOrderStats[branch.id] || { orders: 0, active: 0, delayed: 0, cancelled: 0 };
    const branchRevenue = sum(inMovements.filter((item) => item.branchId === branch.id));
    const branchExpenses = sum(expenseMovements.filter((item) => item.branchId === branch.id));
    const branchInkassa = sum(inkassaMovements.filter((item) => item.branchId === branch.id));
    const delayed = branchOrders.delayed;
    const cancelled = branchOrders.cancelled;

    return {
      branch: branch.name,
      revenue: branchRevenue,
      profit: branchRevenue - branchExpenses - branchInkassa,
      cashOnHand: branchRevenue - branchExpenses - branchInkassa,
      orders: branchOrders.orders,
      active: branchOrders.active,
      delayed,
      cancelled,
      score: Math.max(0, 100 - delayed * 5 - cancelled * 10),
    };
  });

  const sizeAnalytics = orderAnalytics.baggageSizeAnalytics;

  const adminPerformanceMap = {};
  for (const movement of inMovements) {
    const key = userName(movement.createdBy);
    if (!adminPerformanceMap[key]) adminPerformanceMap[key] = { admin: key, orders: 0, revenue: 0, profit: 0, shifts: 0 };
    if (["ORDER_PAYMENT", "DEBT_CLOSE"].includes(movement.type)) adminPerformanceMap[key].orders += asNumber(movement.count || 1);
    adminPerformanceMap[key].revenue += asNumber(movement.amount);
    adminPerformanceMap[key].profit += asNumber(movement.amount);
  }
  for (const shift of shiftsWithReports) {
    const key = userName(shift.openedBy);
    if (!adminPerformanceMap[key]) adminPerformanceMap[key] = { admin: key, orders: 0, revenue: 0, profit: 0, shifts: 0 };
    adminPerformanceMap[key].shifts += 1;
  }

  const shiftRevenueTotal = sum(shiftsWithReports, (shift) => shift.totalRevenue);
  const cashOnHand = cashOnHandByCurrency.UZS;
  const bestShift = shiftsWithReports
    .slice()
    .sort((a, b) => asNumber(b.totalRevenue) - asNumber(a.totalRevenue))[0];

  const result = {
    orderStats: orderAnalytics.orderStats,
    financeAnalytics: {
      revenue: totalRevenue,
      totalExpenses,
      totalInkassa,
      netProfit: totalRevenue - totalExpenses - totalInkassa,
      cashOnHand,
      profitMargin: percent(totalRevenue - totalExpenses - totalInkassa, totalRevenue),
      averageOrder: totalOrders ? Math.round(totalRevenue / totalOrders) : 0,
      averageShiftRevenue: shiftsWithReports.length ? Math.round(shiftRevenueTotal / shiftsWithReports.length) : 0,
      expenseRatio: percent(totalExpenses, totalRevenue),
      inkassa: totalInkassa,
      revenueByCurrency,
      expensesByCurrency,
      inkassaByCurrency,
      debtByCurrency,
      netProfitByCurrency,
      cashOnHandByCurrency,
    },
    revenueByDay,
    expensesByDay,
    inkassaByDay,
    ordersByDay,
    revenueByBranch: movements.filter((m) => m.direction === "IN").reduce((acc, item) => {
      const name = branchName(item);
      acc[name] = (acc[name] || 0) + item.amount;
      return acc;
    }, {}),
    branchComparison,
    revenueByCurrency,
    expensesByCurrency,
    inkassaByCurrency,
    debtByCurrency,
    cashOnHandByCurrency,
    netProfitByCurrency,
    paymentAnalytics: byKeySum(inMovements.filter((item) => item.currency === "UZS"), "paymentType"),
    paymentAnalyticsByCurrency: paymentCurrencyBreakdown(inMovements),
    paymentOrderCounts: countBy(inMovements, (item) => item.paymentType, (item) => item.count || 1),
    lockerUsage: lockers.reduce((acc, locker) => {
      const key = locker.status;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    debtAnalytics: orderAnalytics.debtAnalytics,
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
      total: shiftsWithReports.length,
      open: shiftsWithReports.filter((shift) => shift.status === "OPEN").length,
      closed: shiftsWithReports.filter((shift) => shift.status === "CLOSED").length,
      twelveHour: shiftsWithReports.filter((shift) => String(shift.shiftTime || "").includes("12")).length,
      twentyFourHour: shiftsWithReports.filter((shift) => String(shift.shiftTime || "").includes("24")).length,
      averageRevenue: shiftsWithReports.length ? Math.round(shiftRevenueTotal / shiftsWithReports.length) : 0,
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
    cashMovement: [],
    expenses: [],
    inkassa: [],
    shifts: [],
    peakHours,
    adminActivity: auditLogs,
  };
  timer.end({ rows: orderFacts.rows.length });
  return mergeOrderAnalyticsIntoReport(result, orderAnalytics);
};

const cachedAnalytics = async (type, user, query, loader) => {
  const branchId = getScopedBranchId(user, query.branchId);
  const key = buildAnalyticsCacheKey({
    type,
    role: user.role,
    branchId,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
  });
  const cached = getCachedAnalytics(key);
  if (cached !== undefined) return cached;
  const value = await loader();
  setCachedAnalytics(key, value, branchId);
  return value;
};

const dashboard = (user, query = {}) => cachedAnalytics("dashboard", user, query, () => dashboardUncached(user, query));
const reports = (user, query = {}) => cachedAnalytics("reports", user, query, () => reportsUncached(user, query));

module.exports = {
  dashboard,
  reports,
  _internals: {
    buildOrderAnalyticsFromFacts,
    mergeOrderAnalyticsIntoReport,
  },
};
