const test = require("node:test");
const assert = require("node:assert/strict");
const { filterOrderFacts, mergeOrderFacts } = require("../src/services/orderAnalyticsFacts");
const { _internals } = require("../src/services/analytics.service");

const rows = [
  {
    branchId: "a",
    day: "2026-09-01",
    totalOrders: 3,
    statusCounts: { PICKED_UP: 2, CANCELLED: 1 },
    hourCounts: { 9: 2, 10: 1 },
    sizeStats: { S: { orders: 2, count: 3, amount: 300 }, L: { orders: 1, count: 1, amount: 500 } },
    debtStats: { CLOSED: { UZS: { count: 1, amount: 1000 } } },
  },
  {
    branchId: "a",
    day: "2026-09-27",
    totalOrders: 2,
    statusCounts: { ACTIVE: 1, DELAYED: 1 },
    hourCounts: { 9: 1, 23: 1 },
    sizeStats: { S: { orders: 2, count: 2, amount: 400 } },
    debtStats: { OPEN: { USD: { count: 1, amount: 20 } } },
  },
  {
    branchId: "b",
    day: "2026-09-27",
    totalOrders: 1,
    statusCounts: { PICKED_UP: 1 },
    hourCounts: { 12: 1 },
    sizeStats: { XL: { orders: 1, count: 2, amount: 900 } },
    debtStats: { CLOSED: { USD: { count: 1, amount: 5 } } },
  },
];

const branches = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
];

const factsFor = (scope = {}) => {
  const scopedRows = filterOrderFacts(rows, scope);
  return { rows: scopedRows, total: mergeOrderFacts(...scopedRows) };
};

test("archived facts preserve all-time order analytics fields", () => {
  const result = _internals.buildOrderAnalyticsFromFacts(factsFor(), branches);

  assert.deepEqual(result.orderStats, {
    totalOrders: 6,
    activeOrders: 2,
    delayedOrders: 1,
    cancelledOrders: 1,
    pickedUpOrders: 3,
  });
  assert.deepEqual(result.ordersByDay, { "2026-09-01": 3, "2026-09-27": 3 });
  assert.deepEqual(result.peakHours, { 9: 3, 10: 1, 12: 1, 23: 1 });
  assert.deepEqual(result.branchOrderStats, {
    a: { orders: 5, active: 2, delayed: 1, cancelled: 1 },
    b: { orders: 1, active: 0, delayed: 0, cancelled: 0 },
  });
  assert.deepEqual(result.baggageSizeAnalytics, [
    { size: "S", orders: 4, count: 5, amount: 700 },
    { size: "L", orders: 1, count: 1, amount: 500 },
    { size: "XL", orders: 1, count: 2, amount: 900 },
  ]);
  assert.deepEqual(result.debtAnalytics, { open: 20, closed: 1005 });
  assert.deepEqual(result.debtByCurrency, { UZS: 0, USD: 20, RUB: 0, EUR: 0, KZT: 0, TJS: 0 });
});

test("archived facts preserve today seven-day thirty-day and branch scopes", () => {
  const today = _internals.buildOrderAnalyticsFromFacts(factsFor({ dateFrom: "2026-09-27", dateTo: "2026-09-27" }), branches);
  const sevenDay = _internals.buildOrderAnalyticsFromFacts(factsFor({ dateFrom: "2026-09-21", dateTo: "2026-09-27" }), branches);
  const thirtyDay = _internals.buildOrderAnalyticsFromFacts(factsFor({ dateFrom: "2026-08-29", dateTo: "2026-09-27" }), branches);
  const branch = _internals.buildOrderAnalyticsFromFacts(factsFor({ branchId: "b" }), branches);

  assert.equal(today.orderStats.totalOrders, 3);
  assert.equal(sevenDay.orderStats.totalOrders, 3);
  assert.equal(thirtyDay.orderStats.totalOrders, 6);
  assert.equal(branch.orderStats.totalOrders, 1);
  assert.deepEqual(branch.ordersByDay, { "2026-09-27": 1 });
  assert.equal(branch.branchOrderStats.b.orders, 1);
  assert.equal(branch.branchOrderStats.a.orders, 0);
});

test("merging archived order analytics leaves financial and shift fields unchanged", () => {
  const financial = {
    financeAnalytics: { revenue: 9000, totalExpenses: 2000, totalInkassa: 1000 },
    paymentAnalytics: { CASH: 7000, TERMINAL: 2000 },
    expenseCategories: [{ category: "Rent", amount: 2000, count: 1 }],
    shiftAnalytics: { total: 4, open: 1, closed: 3 },
    adminPerformance: [{ admin: "Admin", revenue: 9000 }],
  };

  const merged = _internals.mergeOrderAnalyticsIntoReport(
    financial,
    _internals.buildOrderAnalyticsFromFacts(factsFor(), branches),
  );

  for (const key of Object.keys(financial)) assert.deepEqual(merged[key], financial[key]);
  assert.equal(merged.orderStats.totalOrders, 6);
  assert.deepEqual(merged.ordersByDay, { "2026-09-01": 3, "2026-09-27": 3 });
});
