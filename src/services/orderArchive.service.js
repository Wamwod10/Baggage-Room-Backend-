const crypto = require("node:crypto");
const { Prisma } = require("@prisma/client");
const prisma = require("../config/prisma");
const { buildOrderFacts, mergeOrderFacts } = require("./orderAnalyticsFacts");

const hashSelection = (orders) => crypto
  .createHash("sha256")
  .update(orders.map((order) => `${order.id}|${new Date(order.createdAt).toISOString()}`).join("\n"))
  .digest("hex");

const confirmationToken = ({ runKey, selectionHash }) => crypto
  .createHash("sha256")
  .update(`${runKey}:${selectionHash}`)
  .digest("hex");

const selectCandidates = async ({ client, runKey, limit }) => {
  const [orders, previousRun] = await Promise.all([
    client.order.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit,
      select: {
        id: true,
        branchId: true,
        status: true,
        createdAt: true,
        items: { select: { size: true, count: true, finalPrice: true } },
        debt: { select: { orderId: true, status: true, amount: true, currency: true } },
        currentLockers: { select: { id: true } },
      },
    }),
    client.orderArchiveRun.findUnique({ where: { key: runKey } }),
  ]);
  const blockers = [];
  if (orders.length !== limit) blockers.push({ code: "count_mismatch", count: orders.length, expected: limit });
  if (previousRun) blockers.push({ code: "duplicate_run_key" });
  const statusCounts = {};
  const branchCounts = {};
  for (const order of orders) {
    statusCounts[order.status] = (statusCounts[order.status] || 0) + 1;
    branchCounts[order.branchId] = (branchCounts[order.branchId] || 0) + 1;
    if (["ACTIVE", "DELAYED"].includes(order.status)) blockers.push({ code: "unsafe_status", status: order.status });
    if (order.debt?.status === "OPEN") blockers.push({ code: "open_debt" });
    if (Array.isArray(order.currentLockers) && order.currentLockers.length) blockers.push({ code: "current_locker" });
    if (!Array.isArray(order.items) || !Array.isArray(order.currentLockers)) blockers.push({ code: "unsupported_relation_shape" });
  }
  const selectionHash = hashSelection(orders);
  return {
    orders,
    plan: {
      runKey,
      requestedCount: limit,
      selectedCount: orders.length,
      firstCreatedAt: orders.length ? new Date(orders[0].createdAt).toISOString() : null,
      lastCreatedAt: orders.length ? new Date(orders.at(-1).createdAt).toISOString() : null,
      statusCounts,
      branchCounts,
      blockers,
      selectionHash,
      confirmationToken: confirmationToken({ runKey, selectionHash }),
    },
  };
};

const buildArchivePlan = async ({ client = prisma, runKey, limit }) =>
  (await selectCandidates({ client, runKey, limit })).plan;

const archiveTotal = async (client) => {
  const result = await client.orderAnalyticsArchive.aggregate({ _sum: { totalOrders: true } });
  return Number(result?._sum?.totalOrders || 0);
};

const upsertFacts = async (client, factsByKey) => {
  for (const facts of factsByKey.values()) {
    const day = new Date(`${facts.day}T00:00:00.000Z`);
    const where = { branchId_day: { branchId: facts.branchId, day } };
    const existing = await client.orderAnalyticsArchive.findUnique({ where });
    const merged = mergeOrderFacts(existing, facts);
    await client.orderAnalyticsArchive.upsert({
      where,
      create: { branchId: facts.branchId, day, ...merged },
      update: merged,
    });
  }
};

const assertExecutable = (plan, token) => {
  if (plan.blockers.length) {
    const error = new Error(`Archive blocked: ${plan.blockers.map((item) => item.code).join(", ")}`);
    error.blockers = plan.blockers;
    throw error;
  }
  if (!token || token !== plan.confirmationToken) throw new Error("Archive confirmation token does not match the current selection");
};

const executeArchivePlan = async ({ client = prisma, runKey, limit, token }) =>
  client.$transaction(async (tx) => {
    let selected = await selectCandidates({ client: tx, runKey, limit });
    assertExecutable(selected.plan, token);
    const ids = selected.orders.map((order) => order.id);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" IN (${Prisma.join(ids)}) FOR UPDATE`);
    selected = await selectCandidates({ client: tx, runKey, limit });
    assertExecutable(selected.plan, token);

    const liveCountBefore = await tx.order.count();
    const archivedBefore = await archiveTotal(tx);
    const combinedCountBefore = liveCountBefore + archivedBefore;
    const debts = selected.orders.filter((order) => order.debt).map((order) => ({ ...order.debt, orderId: order.id }));
    const facts = buildOrderFacts({ orders: selected.orders, debts });
    await upsertFacts(tx, facts);

    await tx.cashMovement.updateMany({ where: { orderId: { in: ids } }, data: { orderId: null } });
    await tx.notification.updateMany({ where: { relatedOrderId: { in: ids } }, data: { relatedOrderId: null } });
    await tx.debt.deleteMany({ where: { orderId: { in: ids }, status: "CLOSED" } });
    await tx.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    const deleted = await tx.order.deleteMany({ where: { id: { in: ids } } });
    if (deleted.count !== limit) throw new Error(`Archive delete count mismatch: expected ${limit}, got ${deleted.count}`);

    const liveCountAfter = await tx.order.count();
    const archivedAfter = await archiveTotal(tx);
    const combinedCountAfter = liveCountAfter + archivedAfter;
    if (liveCountBefore - liveCountAfter !== limit) throw new Error("Live order count invariant failed");
    if (archivedAfter - archivedBefore !== limit) throw new Error("Archived order count invariant failed");
    if (combinedCountBefore !== combinedCountAfter) throw new Error("Combined order count invariant failed");

    await tx.orderArchiveRun.create({
      data: {
        key: runKey,
        selectionHash: selected.plan.selectionHash,
        selectedCount: limit,
        firstCreatedAt: new Date(selected.plan.firstCreatedAt),
        lastCreatedAt: new Date(selected.plan.lastCreatedAt),
        liveCountBefore,
        liveCountAfter,
        combinedCountBefore,
        combinedCountAfter,
      },
    });
    return {
      runKey,
      selectionHash: selected.plan.selectionHash,
      liveDeleted: limit,
      archivedOrderCountDelta: archivedAfter - archivedBefore,
      liveCountBefore,
      liveCountAfter,
      combinedCountBefore,
      combinedCountAfter,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

module.exports = {
  buildArchivePlan,
  confirmationToken,
  executeArchivePlan,
};
