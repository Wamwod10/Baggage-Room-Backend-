const test = require("node:test");
const assert = require("node:assert/strict");
const {
  emptyOrderFacts,
  buildOrderFacts,
  mergeOrderFacts,
  filterOrderFacts,
} = require("../src/services/orderAnalyticsFacts");

const orders = [
  {
    id: "order-a-1",
    branchId: "branch-a",
    status: "PICKED_UP",
    createdAt: new Date("2026-09-27T18:30:00.000Z"),
    clientName: "Private Name",
    phone: "+998900000000",
    passport: "AA0000000",
    note: "private note",
    orderNumber: "TIA-000001",
    items: [
      { size: "S", count: 2, finalPrice: 200 },
      { size: "S", count: 1, finalPrice: 100 },
    ],
  },
  {
    id: "order-a-2",
    branchId: "branch-a",
    status: "CANCELLED",
    createdAt: new Date("2026-09-27T19:30:00.000Z"),
    items: [{ size: "L", count: 1, finalPrice: 500 }],
  },
  {
    id: "order-b-1",
    branchId: "branch-b",
    status: "PICKED_UP",
    createdAt: new Date("2026-09-27T19:30:00.000Z"),
    items: [{ size: "XL", count: "2", finalPrice: "800" }],
  },
];

const debts = [
  { orderId: "order-a-1", status: "CLOSED", currency: "USD", amount: "25" },
  { orderId: "order-a-2", status: "CLOSED", currency: "UZS", amount: 30000 },
];

test("buildOrderFacts buckets by Tashkent day and branch", () => {
  const facts = buildOrderFacts({ orders, debts });

  assert.deepEqual([...facts.keys()], [
    "branch-a|2026-09-27",
    "branch-a|2026-09-28",
    "branch-b|2026-09-28",
  ]);
  assert.equal(facts.get("branch-a|2026-09-27").totalOrders, 1);
  assert.equal(facts.get("branch-a|2026-09-28").totalOrders, 1);
  assert.equal(facts.get("branch-b|2026-09-28").totalOrders, 1);
});

test("buildOrderFacts preserves current status hour size and debt semantics", () => {
  const facts = buildOrderFacts({ orders, debts });
  const first = facts.get("branch-a|2026-09-27");

  assert.deepEqual(first.statusCounts, { PICKED_UP: 1 });
  assert.deepEqual(first.hourCounts, { 23: 1 });
  assert.deepEqual(first.sizeStats, { S: { orders: 2, count: 3, amount: 300 } });
  assert.deepEqual(first.debtStats, { CLOSED: { USD: { count: 1, amount: 25 } } });
  assert.deepEqual(facts.get("branch-a|2026-09-28").debtStats, {
    CLOSED: { UZS: { count: 1, amount: 30000 } },
  });

  const serialized = JSON.stringify([...facts.values()]);
  for (const privateValue of ["Private Name", "+998900000000", "AA0000000", "private note", "TIA-000001", "order-a-1"]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("mergeOrderFacts sums without mutating inputs", () => {
  const left = {
    ...emptyOrderFacts(),
    totalOrders: 2,
    statusCounts: { PICKED_UP: 2 },
    hourCounts: { 9: 2 },
    sizeStats: { S: { orders: 2, count: 3, amount: 400 } },
    debtStats: { CLOSED: { UZS: { count: 1, amount: 1000 } } },
  };
  const right = {
    ...emptyOrderFacts(),
    totalOrders: "1",
    statusCounts: { CANCELLED: "1" },
    hourCounts: { 9: "1" },
    sizeStats: { S: { orders: "1", count: "2", amount: "250" } },
    debtStats: { CLOSED: { UZS: { count: "2", amount: "3000" } } },
  };
  const leftBefore = structuredClone(left);
  const rightBefore = structuredClone(right);

  assert.deepEqual(mergeOrderFacts(left, right), {
    totalOrders: 3,
    statusCounts: { PICKED_UP: 2, CANCELLED: 1 },
    hourCounts: { 9: 3 },
    sizeStats: { S: { orders: 3, count: 5, amount: 650 } },
    debtStats: { CLOSED: { UZS: { count: 3, amount: 4000 } } },
  });
  assert.deepEqual(left, leftBefore);
  assert.deepEqual(right, rightBefore);
});

test("filterOrderFacts keeps inclusive whole-day boundaries", () => {
  const rows = [...buildOrderFacts({ orders, debts }).values()];

  assert.deepEqual(
    filterOrderFacts(rows, { branchId: "branch-a", dateFrom: "2026-09-28", dateTo: "2026-09-28" })
      .map((row) => `${row.branchId}|${row.day}`),
    ["branch-a|2026-09-28"],
  );
  assert.equal(filterOrderFacts(rows, { dateFrom: "2026-09-27", dateTo: "2026-09-28" }).length, 3);
  assert.equal(filterOrderFacts(rows, { dateFrom: "2026-09-29" }).length, 0);
});
