require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { normalizeDatabaseUrl } = require("../src/utils/databaseUrl");

const isProduction = process.env.NODE_ENV === "production";
const isConfirmed = process.env.CONFIRM_RESET === "true";

if (isProduction && !isConfirmed) {
  console.error("Refusing to reset production data.");
  console.error("Set CONFIRM_RESET=true to run this script in production.");
  process.exit(1);
}

const adapter = new PrismaPg({
  connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL),
});

const prisma = new PrismaClient({ adapter });

const resetOrderSequences = async (tx) => {
  const sequences = await tx.$queryRaw`
    SELECT sequence_schema, sequence_name
    FROM information_schema.sequences
    WHERE sequence_schema = current_schema()
      AND (
        lower(sequence_name) IN ('order_seq', 'order_number_seq', 'ordernumber_seq')
        OR lower(sequence_name) LIKE '%order%number%seq%'
      )
  `;

  for (const sequence of sequences) {
    const qualifiedName = `"${sequence.sequence_schema.replace(/"/g, '""')}"."${sequence.sequence_name.replace(/"/g, '""')}"`;
    await tx.$executeRawUnsafe(`SELECT setval('${qualifiedName}'::regclass, 1, false)`);
  }

  return sequences.length;
};

const countSnapshot = async (client) => ({
  users: await client.user.count(),
  branches: await client.branch.count(),
  lockers: await client.locker.count(),
  emptyLockers: await client.locker.count({
    where: {
      status: "EMPTY",
      currentOrderId: null,
      serviceReason: null,
    },
  }),
  tariffs: await client.tariff.count(),
  telegramSettings: await client.telegramSetting.count(),
  orders: await client.order.count(),
  orderItems: await client.orderItem.count(),
  shifts: await client.shift.count(),
  expenses: await client.expense.count(),
  inkassa: await client.inkassa.count(),
  cashMovements: await client.cashMovement.count(),
  debts: await client.debt.count(),
  notifications: await client.notification.count(),
  auditLogs: await client.auditLog.count(),
});

const assertReset = (before, after) => {
  const expectedPreserved = ["users", "branches", "lockers", "tariffs", "telegramSettings"];
  const expectedZero = [
    "orders",
    "orderItems",
    "shifts",
    "expenses",
    "inkassa",
    "cashMovements",
    "debts",
    "notifications",
    "auditLogs",
  ];

  const failed = expectedZero.filter((key) => after[key] !== 0);

  for (const key of expectedPreserved) {
    if (after[key] !== before[key]) {
      failed.push(key);
    }
  }

  if (after.lockers !== after.emptyLockers) {
    failed.push("lockers");
  }

  if (failed.length > 0) {
    throw new Error(`Reset verification failed for: ${failed.join(", ")}`);
  }
};

const main = async () => {
  console.warn("WARNING: This script deletes production operational data.");
  console.warn("Seed data is preserved: Branch, User, Locker, Tariff, TelegramSetting.");
  console.warn("Deleted data: Notification, AuditLog, Debt, CashMovement, Inkassa, Expense, Shift, OrderItem, Order.");

  const before = await countSnapshot(prisma);

  const result = await prisma.$transaction(
    async (tx) => {
      const resetLockers = await tx.locker.updateMany({
        data: {
          status: "EMPTY",
          currentOrderId: null,
          serviceReason: null,
        },
      });

      const deleted = {
        notifications: await tx.notification.deleteMany(),
        auditLogs: await tx.auditLog.deleteMany(),
        debts: await tx.debt.deleteMany(),
        cashMovements: await tx.cashMovement.deleteMany(),
        inkassa: await tx.inkassa.deleteMany(),
        expenses: await tx.expense.deleteMany(),
        shifts: await tx.shift.deleteMany(),
        orderItems: await tx.orderItem.deleteMany(),
        orders: await tx.order.deleteMany(),
      };

      const resetSequences = await resetOrderSequences(tx);

      return {
        resetLockers: resetLockers.count,
        resetSequences,
        deleted: Object.fromEntries(Object.entries(deleted).map(([key, value]) => [key, value.count])),
      };
    },
    { maxWait: 10000, timeout: 120000 },
  );

  const after = await countSnapshot(prisma);
  assertReset(before, after);

  console.log("Production data reset completed.");
  console.log(JSON.stringify({ before, result, after }, null, 2));
  console.log("Order numbers will start from 000001 for each branch code on the next order.");
};

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
