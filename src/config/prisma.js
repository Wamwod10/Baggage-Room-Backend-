const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { normalizeDatabaseUrl } = require("../utils/databaseUrl");
const logger = require("../utils/logger");

const envInt = (name, fallback, min, max) => {
  const value = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};
const perfLogEnabled = /^(1|true|yes)$/i.test(String(process.env.PERF_LOG || ""));
const slowQueryMs = envInt("PERF_SLOW_QUERY_MS", 500, 1, 120000);
const queryFingerprint = (value = "") => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
};

const adapter = new PrismaPg({
  connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL),
  max: envInt("DB_POOL_MAX", 10, 1, 50),
  idleTimeoutMillis: envInt("DB_POOL_IDLE_TIMEOUT_MS", 30000, 1000, 300000),
  connectionTimeoutMillis: envInt("DB_POOL_CONNECTION_TIMEOUT_MS", 5000, 500, 60000),
});

const prisma = new PrismaClient({
  adapter,
  transactionOptions: {
    maxWait: envInt("PRISMA_TRANSACTION_MAX_WAIT", 10000, 1000, 120000),
    timeout: envInt("PRISMA_TRANSACTION_TIMEOUT", 20000, 1000, 120000),
  },
  log: perfLogEnabled
    ? [{ emit: "event", level: "query" }, "error"]
    : process.env.NODE_ENV === "production"
      ? ["error"]
      : ["query", "error", "warn"],
});

if (perfLogEnabled) {
  prisma.$on("query", (event) => {
    if (event.duration < slowQueryMs) return;
    logger.warn("Slow database query", {
      durationMs: event.duration,
      queryHash: queryFingerprint(event.query),
    });
  });
}

module.exports = prisma;
