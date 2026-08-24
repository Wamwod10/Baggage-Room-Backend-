const { markDelayedOrders } = require("../services/order.service");
const logger = require("../utils/logger");

const DEFAULT_INTERVAL_MS = 60 * 1000;
const parseInterval = (value) => {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, 10000), 60 * 60 * 1000) : DEFAULT_INTERVAL_MS;
};

const startOverdueBaggageJob = () => {
  const intervalMs = parseInterval(process.env.OVERDUE_JOB_INTERVAL_MS);
  if (process.env.OVERDUE_JOB_ENABLED === "false") {
    logger.info("Overdue baggage job disabled");
    return null;
  }

  let timerId = null;
  let running = false;
  let stopped = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const count = await markDelayedOrders();
      if (count > 0) logger.info("Overdue baggage job marked delayed orders", { count });
    } catch (error) {
      logger.error("Overdue baggage job failed", { message: error.message });
    } finally {
      running = false;
      if (!stopped) timerId = setTimeout(run, intervalMs);
    }
  };

  void run();
  return {
    stop() {
      stopped = true;
      if (timerId) clearTimeout(timerId);
      timerId = null;
    },
  };
};

module.exports = { startOverdueBaggageJob };
