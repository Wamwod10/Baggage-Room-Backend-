const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildArchivePlan,
  confirmationToken,
  executeArchivePlan,
} = require("../src/services/orderArchive.service");
const { parseArgs } = require("../scripts/archiveOldOrders");

const terminalOrder = (id, createdAt, overrides = {}) => ({
  id,
  branchId: "branch-a",
  status: "PICKED_UP",
  createdAt: new Date(createdAt),
  items: [{ size: "S", count: 1, finalPrice: 100 }],
  debt: null,
  currentLockers: [],
  ...overrides,
});

const createMemoryClient = (seed = {}) => {
  const state = {
    orders: structuredClone(seed.orders || []),
    archives: structuredClone(seed.archives || []),
    runs: structuredClone(seed.runs || []),
    cashMovements: structuredClone(seed.cashMovements || []),
    notifications: structuredClone(seed.notifications || []),
    writes: 0,
    failDelete: Boolean(seed.failDelete),
  };
  const client = {
    state,
    order: {
      findMany: async ({ take }) => structuredClone(state.orders)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || a.id.localeCompare(b.id))
        .slice(0, take),
      count: async () => state.orders.length,
      deleteMany: async ({ where }) => {
        if (state.failDelete) throw new Error("forced delete failure");
        const ids = new Set(where.id.in);
        const before = state.orders.length;
        state.orders = state.orders.filter((order) => !ids.has(order.id));
        state.writes += 1;
        return { count: before - state.orders.length };
      },
    },
    orderArchiveRun: {
      findUnique: async ({ where }) => structuredClone(state.runs.find((run) => run.key === where.key) || null),
      create: async ({ data }) => {
        state.runs.push(structuredClone(data));
        state.writes += 1;
        return data;
      },
    },
    orderAnalyticsArchive: {
      findUnique: async ({ where }) => {
        const key = where.branchId_day;
        return structuredClone(state.archives.find((row) => row.branchId === key.branchId && String(row.day).slice(0, 10) === new Date(key.day).toISOString().slice(0, 10)) || null);
      },
      upsert: async ({ where, create, update }) => {
        const key = where.branchId_day;
        const index = state.archives.findIndex((row) => row.branchId === key.branchId && new Date(row.day).toISOString().slice(0, 10) === new Date(key.day).toISOString().slice(0, 10));
        if (index >= 0) state.archives[index] = { ...state.archives[index], ...structuredClone(update) };
        else state.archives.push(structuredClone(create));
        state.writes += 1;
      },
      aggregate: async () => ({ _sum: { totalOrders: state.archives.reduce((sum, row) => sum + Number(row.totalOrders || 0), 0) } }),
    },
    cashMovement: {
      updateMany: async ({ where }) => {
        const ids = new Set(where.orderId.in);
        state.cashMovements.forEach((row) => { if (ids.has(row.orderId)) row.orderId = null; });
        state.writes += 1;
      },
    },
    notification: {
      updateMany: async ({ where }) => {
        const ids = new Set(where.relatedOrderId.in);
        state.notifications.forEach((row) => { if (ids.has(row.relatedOrderId)) row.relatedOrderId = null; });
        state.writes += 1;
      },
    },
    debt: { deleteMany: async () => { state.writes += 1; } },
    orderItem: { deleteMany: async () => { state.writes += 1; } },
    $queryRaw: async () => [],
  };
  client.$transaction = async (operation) => {
    const before = structuredClone(state);
    try {
      return await operation(client);
    } catch (error) {
      for (const key of Object.keys(state)) state[key] = structuredClone(before[key]);
      throw error;
    }
  };
  return client;
};

test("archive plan deterministically selects oldest orders with id tie breaker", async () => {
  const orders = [
    terminalOrder("b", "2026-01-01T00:00:00.000Z"),
    terminalOrder("a", "2026-01-01T00:00:00.000Z"),
    terminalOrder("c", "2026-01-02T00:00:00.000Z"),
  ];
  const first = await buildArchivePlan({ client: createMemoryClient({ orders }), runKey: "initial-5000", limit: 2 });
  const second = await buildArchivePlan({ client: createMemoryClient({ orders: [...orders].reverse() }), runKey: "initial-5000", limit: 2 });

  assert.equal(first.selectionHash, second.selectionHash);
  assert.equal(first.selectedCount, 2);
  assert.equal(first.firstCreatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(first.lastCreatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(first.blockers.length, 0);
  assert.equal(first.confirmationToken, confirmationToken({ runKey: "initial-5000", selectionHash: first.selectionHash }));
  assert.equal(JSON.stringify(first).includes('"id"'), false);
});

test("archive dry-run performs no writes", async () => {
  const client = createMemoryClient({ orders: [terminalOrder("a", "2026-01-01T00:00:00.000Z")] });
  const before = structuredClone(client.state);
  await buildArchivePlan({ client, runKey: "dry-run", limit: 1 });
  assert.deepEqual(client.state, before);
});

test("archive plan reports every unsafe blocker", async () => {
  const cases = [
    [terminalOrder("a", "2026-01-01T00:00:00.000Z", { status: "ACTIVE" }), "unsafe_status"],
    [terminalOrder("a", "2026-01-01T00:00:00.000Z", { status: "DELAYED" }), "unsafe_status"],
    [terminalOrder("a", "2026-01-01T00:00:00.000Z", { debt: { status: "OPEN", amount: 1, currency: "UZS" } }), "open_debt"],
    [terminalOrder("a", "2026-01-01T00:00:00.000Z", { currentLockers: [{ id: "locker" }] }), "current_locker"],
  ];
  for (const [order, blocker] of cases) {
    const plan = await buildArchivePlan({ client: createMemoryClient({ orders: [order] }), runKey: `case-${blocker}`, limit: 1 });
    assert.ok(plan.blockers.some((item) => item.code === blocker), blocker);
  }
  const short = await buildArchivePlan({ client: createMemoryClient({ orders: [] }), runKey: "short-run", limit: 1 });
  assert.ok(short.blockers.some((item) => item.code === "count_mismatch"));
  const duplicate = await buildArchivePlan({ client: createMemoryClient({ orders: [terminalOrder("a", "2026-01-01T00:00:00.000Z")], runs: [{ key: "done" }] }), runKey: "done", limit: 1 });
  assert.ok(duplicate.blockers.some((item) => item.code === "duplicate_run_key"));
});

test("archive execution rejects stale tokens and changed selections", async () => {
  const client = createMemoryClient({ orders: [terminalOrder("b", "2026-01-02T00:00:00.000Z")] });
  const plan = await buildArchivePlan({ client, runKey: "initial-run", limit: 1 });
  await assert.rejects(() => executeArchivePlan({ client, runKey: "initial-run", limit: 1, token: "stale" }), /confirmation/i);
  client.state.orders.push(terminalOrder("a", "2026-01-01T00:00:00.000Z"));
  await assert.rejects(() => executeArchivePlan({ client, runKey: "initial-run", limit: 1, token: plan.confirmationToken }), /confirmation/i);
  assert.equal(client.state.writes, 0);
});

test("archive execution preserves financial relations and commits aggregate counts", async () => {
  const orders = [
    terminalOrder("a", "2026-01-01T00:00:00.000Z", { debt: { orderId: "a", status: "CLOSED", amount: 1000, currency: "UZS" } }),
    terminalOrder("b", "2026-01-02T00:00:00.000Z", { branchId: "branch-b" }),
    terminalOrder("live", "2026-01-03T00:00:00.000Z", { status: "ACTIVE" }),
  ];
  const client = createMemoryClient({
    orders,
    cashMovements: [{ id: "m", orderId: "a", amount: 100 }],
    notifications: [{ id: "n", relatedOrderId: "b" }],
  });
  const plan = await buildArchivePlan({ client, runKey: "initial-run", limit: 2 });
  const result = await executeArchivePlan({ client, runKey: "initial-run", limit: 2, token: plan.confirmationToken });

  assert.equal(result.liveDeleted, 2);
  assert.equal(result.archivedOrderCountDelta, 2);
  assert.equal(result.combinedCountBefore, result.combinedCountAfter);
  assert.deepEqual(client.state.orders.map((order) => order.id), ["live"]);
  assert.equal(client.state.cashMovements[0].orderId, null);
  assert.equal(client.state.notifications[0].relatedOrderId, null);
  assert.equal(client.state.archives.reduce((sum, row) => sum + row.totalOrders, 0), 2);
  assert.equal(client.state.runs.length, 1);
});

test("archive transaction rolls back every write on failure", async () => {
  const client = createMemoryClient({ orders: [terminalOrder("a", "2026-01-01T00:00:00.000Z")], failDelete: true });
  const plan = await buildArchivePlan({ client, runKey: "rollback-run", limit: 1 });
  const before = structuredClone(client.state);
  await assert.rejects(() => executeArchivePlan({ client, runKey: "rollback-run", limit: 1, token: plan.confirmationToken }), /forced delete failure/);
  assert.deepEqual(client.state, before);
});

test("archive CLI defaults to dry-run and validates destructive arguments", () => {
  assert.deepEqual(parseArgs(["--run-key=initial-run", "--limit=5000"]), {
    runKey: "initial-run",
    limit: 5000,
    execute: false,
    confirm: null,
  });
  assert.throws(() => parseArgs(["--limit=1"]), /run-key/i);
  assert.throws(() => parseArgs(["--run-key=x", "--limit=1"]), /run-key/i);
  assert.throws(() => parseArgs(["--run-key=valid-run", "--limit=5001"]), /limit/i);
  assert.throws(() => parseArgs(["--run-key=valid-run", "--limit=1", "--execute"]), /confirm/i);
});
