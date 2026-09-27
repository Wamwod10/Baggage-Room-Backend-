const { Prisma } = require("@prisma/client");
const prisma = require("../config/prisma");
const {
  emptyOrderFacts,
  mergeOrderFacts,
  filterOrderFacts,
} = require("../services/orderAnalyticsFacts");

const toDay = (value) => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value || "").slice(0, 10);
};

const archiveDate = (value) => value ? new Date(`${value}T00:00:00.000Z`) : undefined;

const scopeSql = ({ branchId, dateFrom, dateTo } = {}) => Prisma.sql`
  AND (${branchId || null}::text IS NULL OR o."branchId" = ${branchId || null})
  AND (${dateFrom || null}::date IS NULL OR (o."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tashkent')::date >= ${dateFrom || null}::date)
  AND (${dateTo || null}::date IS NULL OR (o."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tashkent')::date <= ${dateTo || null}::date)
`;

const bucketFor = (buckets, branchId, dayValue) => {
  const day = toDay(dayValue);
  const key = `${branchId}|${day}`;
  if (!buckets.has(key)) buckets.set(key, { branchId, day, ...emptyOrderFacts() });
  return buckets.get(key);
};

const loadLiveOrderFacts = async (scope = {}, client = prisma) => {
  const predicates = scopeSql(scope);
  const [orderRows, sizeRows, debtRows] = await Promise.all([
    client.$queryRaw(Prisma.sql`
      SELECT o."branchId",
             to_char((o."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tashkent')::date, 'YYYY-MM-DD') AS "day",
             o."status"::text AS "status",
             EXTRACT(HOUR FROM o."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tashkent')::int AS "hour",
             COUNT(*)::int AS "total"
      FROM "Order" o
      WHERE TRUE ${predicates}
      GROUP BY o."branchId", "day", o."status", "hour"
    `),
    client.$queryRaw(Prisma.sql`
      SELECT o."branchId",
             to_char((o."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tashkent')::date, 'YYYY-MM-DD') AS "day",
             i."size"::text AS "size",
             COUNT(*)::int AS "orders",
             COALESCE(SUM(i."count"), 0)::int AS "count",
             COALESCE(SUM(i."finalPrice"), 0)::bigint AS "amount"
      FROM "Order" o
      JOIN "OrderItem" i ON i."orderId" = o."id"
      WHERE TRUE ${predicates}
      GROUP BY o."branchId", "day", i."size"
    `),
    client.$queryRaw(Prisma.sql`
      SELECT o."branchId",
             to_char((o."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tashkent')::date, 'YYYY-MM-DD') AS "day",
             d."status"::text AS "status",
             d."currency"::text AS "currency",
             COUNT(*)::int AS "count",
             COALESCE(SUM(d."amount"), 0)::bigint AS "amount"
      FROM "Order" o
      JOIN "Debt" d ON d."orderId" = o."id"
      WHERE TRUE ${predicates}
      GROUP BY o."branchId", "day", d."status", d."currency"
    `),
  ]);

  const buckets = new Map();
  for (const row of orderRows) {
    const bucket = bucketFor(buckets, row.branchId, row.day);
    const total = Number(row.total || 0);
    bucket.totalOrders += total;
    bucket.statusCounts[row.status] = Number(bucket.statusCounts[row.status] || 0) + total;
    bucket.hourCounts[row.hour] = Number(bucket.hourCounts[row.hour] || 0) + total;
  }
  for (const row of sizeRows) {
    const bucket = bucketFor(buckets, row.branchId, row.day);
    bucket.sizeStats[row.size] = {
      orders: Number(row.orders || 0),
      count: Number(row.count || 0),
      amount: Number(row.amount || 0),
    };
  }
  for (const row of debtRows) {
    const bucket = bucketFor(buckets, row.branchId, row.day);
    const byStatus = bucket.debtStats[row.status] || {};
    byStatus[row.currency] = { count: Number(row.count || 0), amount: Number(row.amount || 0) };
    bucket.debtStats[row.status] = byStatus;
  }
  return [...buckets.values()];
};

const loadArchivedOrderFacts = async (scope = {}, client = prisma) => {
  const rows = await client.orderAnalyticsArchive.findMany({
    where: {
      ...(scope.branchId ? { branchId: scope.branchId } : {}),
      ...((scope.dateFrom || scope.dateTo) ? {
        day: {
          ...(scope.dateFrom ? { gte: archiveDate(scope.dateFrom) } : {}),
          ...(scope.dateTo ? { lte: archiveDate(scope.dateTo) } : {}),
        },
      } : {}),
    },
    select: {
      branchId: true,
      day: true,
      totalOrders: true,
      statusCounts: true,
      hourCounts: true,
      sizeStats: true,
      debtStats: true,
    },
    orderBy: [{ day: "asc" }, { branchId: "asc" }],
  });

  return filterOrderFacts(
    rows.map((row) => ({ branchId: row.branchId, day: toDay(row.day), ...mergeOrderFacts(row) })),
    scope,
  );
};

const loadCombinedOrderFacts = async (scope = {}, client = prisma, timer = { time: (_name, fn) => fn() }) => {
  const [liveRows, archivedRows] = await Promise.all([
    timer.time("live-order-facts", () => loadLiveOrderFacts(scope, client)),
    timer.time("archive-order-facts", () => loadArchivedOrderFacts(scope, client)),
  ]);
  return timer.time("analytics-merge", async () => {
    const combined = new Map();
    for (const row of [...liveRows, ...archivedRows]) {
      const key = `${row.branchId}|${row.day}`;
      const previous = combined.get(key);
      combined.set(key, {
        branchId: row.branchId,
        day: row.day,
        ...mergeOrderFacts(previous, row),
      });
    }
    const rows = [...combined.values()].sort((left, right) =>
      left.day.localeCompare(right.day) || left.branchId.localeCompare(right.branchId));
    return { rows, total: mergeOrderFacts(...rows) };
  });
};

module.exports = {
  loadLiveOrderFacts,
  loadArchivedOrderFacts,
  loadCombinedOrderFacts,
};
