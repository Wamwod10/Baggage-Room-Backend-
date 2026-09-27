const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeAnalyticsSnapshot,
  verifyArchiveSnapshots,
} = require("../scripts/verifyAnalyticsArchive");

const snapshot = () => ({
  timing: { totalMs: 999 },
  cache: { hit: false },
  analytics: {
    all: {
      orderStats: { totalOrders: 11021, activeOrders: 10, cancelledOrders: 30 },
      ordersByDay: { "2026-09-27": 50 },
      peakHours: { 9: 12 },
      branchComparison: [{ branch: "Alpha", orders: 100, revenue: 5000 }],
      baggageSizeAnalytics: [{ size: "S", orders: 30, count: 31, amount: 9000 }],
      debtAnalytics: { open: 100, closed: 200 },
      financeAnalytics: { revenue: 5000, totalExpenses: 1000, totalInkassa: 500 },
      shiftAnalytics: { total: 4, open: 1, closed: 3 },
    },
    today: { orderStats: { totalOrders: 50 } },
  },
  salesHistoryTotal: 11021,
  activeOrders: { count: 2, ids: ["active-a", "active-b"] },
  lockers: [
    { id: "locker-a", status: "BUSY", currentOrderId: "active-a" },
    { id: "locker-b", status: "EMPTY", currentOrderId: null },
  ],
});

test("snapshot normalization removes volatile metadata and is deterministic", () => {
  const first = snapshot();
  const second = snapshot();
  second.timing.totalMs = 1;
  second.cache.hit = true;
  second.generatedAt = "later";
  second.activeOrders.ids.reverse();
  second.lockers.reverse();

  assert.deepEqual(normalizeAnalyticsSnapshot(first), normalizeAnalyticsSnapshot(second));
});

test("archive verifier accepts unchanged analytics and exact sales-history reduction", () => {
  const before = snapshot();
  const after = snapshot();
  after.salesHistoryTotal -= 5000;

  assert.deepEqual(verifyArchiveSnapshots(before, after, { archivedCount: 5000 }), { ok: true, errors: [] });
});

test("archive verifier detects every protected analytics and operational change", () => {
  const mutations = [
    (value) => { value.analytics.all.orderStats.totalOrders += 1; },
    (value) => { value.analytics.all.orderStats.cancelledOrders += 1; },
    (value) => { value.analytics.all.ordersByDay["2026-09-27"] += 1; },
    (value) => { value.analytics.all.peakHours[9] += 1; },
    (value) => { value.analytics.all.branchComparison[0].orders += 1; },
    (value) => { value.analytics.all.baggageSizeAnalytics[0].count += 1; },
    (value) => { value.analytics.all.debtAnalytics.closed += 1; },
    (value) => { value.analytics.all.financeAnalytics.revenue += 1; },
    (value) => { value.activeOrders.count += 1; },
    (value) => { value.activeOrders.ids.push("active-c"); },
    (value) => { value.lockers[0].status = "EMPTY"; },
  ];

  for (const mutate of mutations) {
    const before = snapshot();
    const after = snapshot();
    after.salesHistoryTotal -= 5000;
    mutate(after);
    const result = verifyArchiveSnapshots(before, after, { archivedCount: 5000 });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  }
});

test("archive verifier rejects wrong sales-history delta and sensitive snapshot fields", () => {
  const before = snapshot();
  const after = snapshot();
  after.salesHistoryTotal -= 4999;
  assert.equal(verifyArchiveSnapshots(before, after, { archivedCount: 5000 }).ok, false);

  before.customer = { phone: "+998900000000" };
  assert.throws(() => normalizeAnalyticsSnapshot(before), /sensitive/i);
});
