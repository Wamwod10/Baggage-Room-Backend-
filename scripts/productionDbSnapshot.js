/* Read-only PostgreSQL snapshot for release validation. */
const prisma = require("../src/config/prisma");

const main = async () => {
  const [connections, indexes, openShifts] = await Promise.all([
    prisma.$queryRaw`
      SELECT
        current_database()::text AS database,
        current_setting('max_connections')::int AS max_connections,
        COUNT(*)::int AS total_connections,
        COUNT(*) FILTER (WHERE state = 'active')::int AS active_connections,
        pg_size_pretty(pg_database_size(current_database())) AS database_size
      FROM pg_stat_activity
      WHERE datname = current_database()
    `,
    prisma.$queryRaw`
      SELECT indexname::text
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'Shift_one_open_per_branch_idx',
          'Order_idempotencyKey_key',
          'Notification_branchId_isRead_priority_createdAt_idx'
        )
      ORDER BY indexname
    `,
    prisma.shift.groupBy({
      by: ["branchId"],
      where: { status: "OPEN" },
      _count: { _all: true },
    }),
  ]);

  process.stdout.write(`${JSON.stringify({ connections, indexes, openShifts }, null, 2)}\n`);
};

main()
  .catch((error) => {
    process.stderr.write(`DB snapshot failed: ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
