const DEFAULT_TTL_MS = 30000;
const DEFAULT_MAX_ENTRIES = 100;

const cloneValue = (value) => value === undefined ? undefined : structuredClone(value);

const buildAnalyticsCacheKey = ({ type, role, branchId, dateFrom, dateTo } = {}) =>
  JSON.stringify([
    String(type || "analytics"),
    String(role || "UNKNOWN"),
    branchId || null,
    dateFrom || null,
    dateTo || null,
  ]);

const createAnalyticsCache = ({ now = Date.now, ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) => {
  const entries = new Map();

  const get = (key) => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (now() >= entry.expiresAt) {
      entries.delete(key);
      return undefined;
    }
    return cloneValue(entry.value);
  };

  const set = (key, value, branchId = null) => {
    if (entries.has(key)) entries.delete(key);
    entries.set(key, { value: cloneValue(value), branchId: branchId || null, expiresAt: now() + ttlMs });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  };

  const invalidate = (branchId) => {
    if (!branchId) {
      entries.clear();
      return;
    }
    for (const [key, entry] of entries) {
      if (entry.branchId === branchId || entry.branchId === null) entries.delete(key);
    }
  };

  return { get, set, invalidate };
};

const analyticsCache = createAnalyticsCache();

const getCachedAnalytics = (key) => analyticsCache.get(key);
const setCachedAnalytics = (key, value, branchId) => analyticsCache.set(key, value, branchId);
const invalidateAnalyticsCache = (branchId) => analyticsCache.invalidate(branchId);

module.exports = {
  buildAnalyticsCacheKey,
  createAnalyticsCache,
  getCachedAnalytics,
  setCachedAnalytics,
  invalidateAnalyticsCache,
};
