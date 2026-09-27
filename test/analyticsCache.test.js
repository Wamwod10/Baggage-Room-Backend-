const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createAnalyticsCache,
  buildAnalyticsCacheKey,
} = require("../src/services/analyticsCache");

test("analytics cache expires values at thirty seconds", () => {
  let now = 1000;
  const cache = createAnalyticsCache({ now: () => now });
  cache.set("key", { total: 1 }, "branch-a");

  now = 30999;
  assert.deepEqual(cache.get("key"), { total: 1 });
  now = 31000;
  assert.equal(cache.get("key"), undefined);
});

test("analytics cache keys isolate role branch and date range", () => {
  const base = { type: "reports", role: "SUPER_ADMIN", branchId: "branch-a", dateFrom: "2026-09-01", dateTo: "2026-09-30" };
  const keys = new Set([
    buildAnalyticsCacheKey(base),
    buildAnalyticsCacheKey({ ...base, role: "BRANCH_ADMIN" }),
    buildAnalyticsCacheKey({ ...base, branchId: "branch-b" }),
    buildAnalyticsCacheKey({ ...base, dateFrom: "2026-09-02" }),
    buildAnalyticsCacheKey({ ...base, dateTo: "2026-09-29" }),
  ]);
  assert.equal(keys.size, 5);
});

test("analytics cache returns defensive copies", () => {
  const cache = createAnalyticsCache();
  const source = { overview: { total: 2 }, rows: [{ day: "2026-09-27" }] };
  cache.set("key", source, "branch-a");
  source.overview.total = 99;
  const first = cache.get("key");
  first.rows[0].day = "changed";

  assert.deepEqual(cache.get("key"), { overview: { total: 2 }, rows: [{ day: "2026-09-27" }] });
});

test("branch invalidation preserves other branches and global invalidation clears all", () => {
  const cache = createAnalyticsCache();
  cache.set("a", { total: 1 }, "branch-a");
  cache.set("b", { total: 2 }, "branch-b");
  cache.invalidate("branch-a");

  assert.equal(cache.get("a"), undefined);
  assert.deepEqual(cache.get("b"), { total: 2 });
  cache.invalidate();
  assert.equal(cache.get("b"), undefined);
});

test("analytics cache evicts the oldest entry after one hundred keys", () => {
  const cache = createAnalyticsCache();
  for (let index = 0; index <= 100; index += 1) cache.set(`key-${index}`, { index }, "branch-a");
  assert.equal(cache.get("key-0"), undefined);
  assert.deepEqual(cache.get("key-100"), { index: 100 });
});
