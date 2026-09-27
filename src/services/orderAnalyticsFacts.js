const { formatTashkentDateKey, getTashkentParts } = require("../utils/date");

const toNumber = (value) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
};

const emptyOrderFacts = () => ({
  totalOrders: 0,
  statusCounts: {},
  hourCounts: {},
  sizeStats: {},
  debtStats: {},
});

const addNumberMap = (target, source = {}) => {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = toNumber(target[key]) + toNumber(value);
  }
};

const addSizeStats = (target, source = {}) => {
  for (const [size, stats] of Object.entries(source || {})) {
    const current = target[size] || { orders: 0, count: 0, amount: 0 };
    target[size] = {
      orders: toNumber(current.orders) + toNumber(stats?.orders),
      count: toNumber(current.count) + toNumber(stats?.count),
      amount: toNumber(current.amount) + toNumber(stats?.amount),
    };
  }
};

const addDebtStats = (target, source = {}) => {
  for (const [status, currencies] of Object.entries(source || {})) {
    const targetStatus = target[status] || {};
    target[status] = targetStatus;
    for (const [currency, stats] of Object.entries(currencies || {})) {
      const current = targetStatus[currency] || { count: 0, amount: 0 };
      targetStatus[currency] = {
        count: toNumber(current.count) + toNumber(stats?.count),
        amount: toNumber(current.amount) + toNumber(stats?.amount),
      };
    }
  }
};

const mergeOrderFacts = (...factsList) => {
  const merged = emptyOrderFacts();
  for (const facts of factsList.filter(Boolean)) {
    merged.totalOrders += toNumber(facts.totalOrders);
    addNumberMap(merged.statusCounts, facts.statusCounts);
    addNumberMap(merged.hourCounts, facts.hourCounts);
    addSizeStats(merged.sizeStats, facts.sizeStats);
    addDebtStats(merged.debtStats, facts.debtStats);
  }
  return merged;
};

const createBucket = (branchId, day) => ({ branchId, day, ...emptyOrderFacts() });

const buildOrderFacts = ({ orders = [], debts = [] } = {}) => {
  const buckets = new Map();
  const bucketByOrderId = new Map();

  for (const order of orders) {
    const day = formatTashkentDateKey(order.createdAt);
    const key = `${order.branchId}|${day}`;
    const bucket = buckets.get(key) || createBucket(order.branchId, day);
    buckets.set(key, bucket);
    bucketByOrderId.set(order.id, bucket);

    bucket.totalOrders += 1;
    bucket.statusCounts[order.status] = toNumber(bucket.statusCounts[order.status]) + 1;
    const hour = String(getTashkentParts(order.createdAt).hour);
    bucket.hourCounts[hour] = toNumber(bucket.hourCounts[hour]) + 1;

    for (const item of order.items || []) {
      const size = item.size || "UNKNOWN";
      const current = bucket.sizeStats[size] || { orders: 0, count: 0, amount: 0 };
      bucket.sizeStats[size] = {
        orders: current.orders + 1,
        count: current.count + toNumber(item.count || 1),
        amount: current.amount + toNumber(item.finalPrice),
      };
    }
  }

  for (const debt of debts) {
    const bucket = bucketByOrderId.get(debt.orderId);
    if (!bucket) continue;
    const status = debt.status || "UNKNOWN";
    const currency = debt.currency || "UZS";
    const statusStats = bucket.debtStats[status] || {};
    const current = statusStats[currency] || { count: 0, amount: 0 };
    statusStats[currency] = {
      count: current.count + 1,
      amount: current.amount + toNumber(debt.amount),
    };
    bucket.debtStats[status] = statusStats;
  }

  return new Map([...buckets].map(([key, facts]) => [
    key,
    { branchId: facts.branchId, day: facts.day, ...mergeOrderFacts(facts) },
  ]));
};

const filterOrderFacts = (rows = [], { branchId, dateFrom, dateTo } = {}) =>
  rows
    .filter((row) => !branchId || row.branchId === branchId)
    .filter((row) => !dateFrom || row.day >= dateFrom)
    .filter((row) => !dateTo || row.day <= dateTo)
    .map((row) => ({ branchId: row.branchId, day: row.day, ...mergeOrderFacts(row) }));

module.exports = {
  emptyOrderFacts,
  buildOrderFacts,
  mergeOrderFacts,
  filterOrderFacts,
};
