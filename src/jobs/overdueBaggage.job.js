const { markDelayedOrders } = require("../services/order.service");
const logger = require("../utils/logger");

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

const startOverdueBaggageJob = () => {
  const intervalMs = Number(process.env.OVERDUE_JOB_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  if (process.env.OVERDUE_JOB_ENABLED === "false") {
    logger.info("Overdue baggage job disabled");
    return null;
  }

  const run = async () => {
    try {
      const count = await markDelayedOrders();
      if (count > 0) logger.info("Overdue baggage job marked delayed orders", { count });
    } catch (error) {
      logger.error("Overdue baggage job failed", { message: error.message });
    }
  };

  run();
  return setInterval(run, intervalMs);
};

module.exports = { startOverdueBaggageJob };
