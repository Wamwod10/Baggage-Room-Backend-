require("dotenv").config();

const app = require("./app");
const prisma = require("./config/prisma");
const { startOverdueBaggageJob } = require("./jobs/overdueBaggage.job");
const logger = require("./utils/logger");

const configuredPort = Number.parseInt(process.env.PORT || "", 10);
const port = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 5000;
const overdueJob = startOverdueBaggageJob();

const server = app.listen(port, () => {
  logger.info("Baggage Room API running", { port });
});

let shutdownPromise = null;
const shutdown = async () => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    overdueJob?.stop?.();
    const closePromise = new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(resolve);
    });
    let forceCloseTimer = null;
    await Promise.race([
      closePromise,
      new Promise((resolve) => {
        forceCloseTimer = setTimeout(resolve, 10000);
      }),
    ]);
    if (forceCloseTimer) clearTimeout(forceCloseTimer);
    await prisma.$disconnect();
  })();
  return shutdownPromise;
};

const handleFatal = (source, error) => {
  logger.error(`Fatal process error: ${source}`, {
    message: error?.message || String(error),
    ...(process.env.NODE_ENV !== "production" && error?.stack ? { stack: error.stack } : {}),
  });
  void shutdown().finally(() => process.exit(1));
};

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.on("unhandledRejection", (reason) => handleFatal("unhandledRejection", reason));
process.on("uncaughtException", (error) => handleFatal("uncaughtException", error));
