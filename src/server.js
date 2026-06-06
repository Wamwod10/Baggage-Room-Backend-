require("dotenv").config();

const app = require("./app");
const prisma = require("./config/prisma");
const { startOverdueBaggageJob } = require("./jobs/overdueBaggage.job");
const logger = require("./utils/logger");

const port = Number(process.env.PORT || 5000);
const overdueJob = startOverdueBaggageJob();

const server = app.listen(port, () => {
  logger.info("Baggage Room API running", { port });
});

const shutdown = async () => {
  if (overdueJob) clearInterval(overdueJob);
  await prisma.$disconnect();
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
