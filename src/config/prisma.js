const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { normalizeDatabaseUrl } = require("../utils/databaseUrl");

const adapter = new PrismaPg({
  connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL),
});

const prisma = new PrismaClient({
  adapter,
  transactionOptions: {
    maxWait: Number(process.env.PRISMA_TRANSACTION_MAX_WAIT || 10000),
    timeout: Number(process.env.PRISMA_TRANSACTION_TIMEOUT || 20000),
  },
  log: process.env.NODE_ENV === "production" ? ["error"] : ["query", "error", "warn"],
});

module.exports = prisma;
