const test = require("node:test");
const assert = require("node:assert/strict");
const { Prisma } = require("@prisma/client");
const {
  loadCombinedOrderFacts,
} = require("../src/repositories/orderAnalytics.repository");

const fakeClient = ({ liveQueries, archivedRows }) => {
  let queryIndex = 0;
  return {
    $queryRaw: async () => structuredClone(liveQueries[queryIndex++] || []),
    orderAnalyticsArchive: {
      findMany: async () => structuredClone(archivedRows),
    },
  };
};

test("loadCombinedOrderFacts merges live and archive buckets once", async () => {
  const client = fakeClient({
    liveQueries: [
      [
        { branchId: "branch-a", day: "2026-09-27", status: "PICKED_UP", hour: 10, total: 2 },
        { branchId: "branch-b", day: "2026-09-27", status: "CANCELLED", hour: 11, total: 1 },
      ],
      [{ branchId: "branch-a", day: "2026-09-27", size: "S", orders: 2, count: 3, amount: 400 }],
      [{ branchId: "branch-a", day: "2026-09-27", status: "CLOSED", currency: "UZS", count: 1, amount: 5000 }],
    ],
    archivedRows: [
      {
        branchId: "branch-a",
        day: new Date("2026-09-27T00:00:00.000Z"),
        totalOrders: 3,
        statusCounts: { PICKED_UP: 2, CANCELLED: 1 },
        hourCounts: { 9: 3 },
        sizeStats: { S: { orders: 3, count: 3, amount: 600 } },
        debtStats: { CLOSED: { USD: { count: 1, amount: 25 } } },
      },
    ],
  });

  const result = await loadCombinedOrderFacts(
    { branchId: null, dateFrom: "2026-09-27", dateTo: "2026-09-27" },
    client,
  );

  assert.deepEqual(result.rows, [
    {
      branchId: "branch-a",
      day: "2026-09-27",
      totalOrders: 5,
      statusCounts: { PICKED_UP: 4, CANCELLED: 1 },
      hourCounts: { 10: 2, 9: 3 },
      sizeStats: { S: { orders: 5, count: 6, amount: 1000 } },
      debtStats: {
        CLOSED: {
          UZS: { count: 1, amount: 5000 },
          USD: { count: 1, amount: 25 },
        },
      },
    },
    {
      branchId: "branch-b",
      day: "2026-09-27",
      totalOrders: 1,
      statusCounts: { CANCELLED: 1 },
      hourCounts: { 11: 1 },
      sizeStats: {},
      debtStats: {},
    },
  ]);
  assert.equal(result.total.totalOrders, 6);
  assert.deepEqual(result.total.statusCounts, { PICKED_UP: 4, CANCELLED: 2 });
});

test("loadCombinedOrderFacts keeps branch and date scope out of other buckets", async () => {
  const client = fakeClient({
    liveQueries: [[], [], []],
    archivedRows: [
      {
        branchId: "branch-a",
        day: new Date("2026-09-28T00:00:00.000Z"),
        totalOrders: 2,
        statusCounts: { PICKED_UP: 2 },
        hourCounts: {},
        sizeStats: {},
        debtStats: {},
      },
      {
        branchId: "branch-b",
        day: new Date("2026-09-28T00:00:00.000Z"),
        totalOrders: 99,
        statusCounts: { PICKED_UP: 99 },
        hourCounts: {},
        sizeStats: {},
        debtStats: {},
      },
    ],
  });

  const result = await loadCombinedOrderFacts(
    { branchId: "branch-a", dateFrom: "2026-09-28", dateTo: "2026-09-28" },
    client,
  );

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].branchId, "branch-a");
  assert.equal(result.total.totalOrders, 2);
});

test("generated Prisma metadata exposes the archive models and uniqueness", () => {
  const archive = Prisma.dmmf.datamodel.models.find((model) => model.name === "OrderAnalyticsArchive");
  const run = Prisma.dmmf.datamodel.models.find((model) => model.name === "OrderArchiveRun");

  assert.ok(archive);
  assert.deepEqual(archive.uniqueFields, [["branchId", "day"]]);
  assert.deepEqual(
    archive.fields.filter((field) => ["branchId", "day", "totalOrders", "statusCounts", "hourCounts", "sizeStats", "debtStats"].includes(field.name)).map((field) => field.name),
    ["branchId", "day", "totalOrders", "statusCounts", "hourCounts", "sizeStats", "debtStats"],
  );
  assert.ok(run);
  assert.equal(run.fields.find((field) => field.name === "key").isId, true);
  for (const field of ["selectionHash", "selectedCount", "firstCreatedAt", "lastCreatedAt", "liveCountBefore", "liveCountAfter", "combinedCountBefore", "combinedCountAfter", "executedAt"]) {
    assert.ok(run.fields.some((item) => item.name === field), field);
  }
});
