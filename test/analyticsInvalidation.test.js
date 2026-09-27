const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getCachedAnalytics,
  setCachedAnalytics,
  invalidateAnalyticsCache,
  markAnalyticsMutation,
} = require("../src/services/analyticsCache");

const seed = () => {
  invalidateAnalyticsCache();
  setCachedAnalytics("branch-a", { value: "a" }, "branch-a");
  setCachedAnalytics("branch-b", { value: "b" }, "branch-b");
  setCachedAnalytics("all", { value: "all" }, null);
};

test("successful mutation invalidates its branch and all-branch analytics", () => {
  seed();
  markAnalyticsMutation({ branchId: "branch-a" });

  assert.equal(getCachedAnalytics("branch-a"), undefined);
  assert.equal(getCachedAnalytics("all"), undefined);
  assert.deepEqual(getCachedAnalytics("branch-b"), { value: "b" });
});

test("mutation invalidation accepts a committed fallback branch", () => {
  seed();
  markAnalyticsMutation({}, { fallbackBranchId: "branch-b" });
  assert.deepEqual(getCachedAnalytics("branch-a"), { value: "a" });
  assert.equal(getCachedAnalytics("branch-b"), undefined);
});

test("idempotent replay and absent committed result preserve cache", () => {
  seed();
  markAnalyticsMutation({ branchId: "branch-a" }, { replayed: true });
  markAnalyticsMutation(null, { fallbackBranchId: "branch-a" });

  assert.deepEqual(getCachedAnalytics("branch-a"), { value: "a" });
  assert.deepEqual(getCachedAnalytics("branch-b"), { value: "b" });
  assert.deepEqual(getCachedAnalytics("all"), { value: "all" });
  invalidateAnalyticsCache();
});
