const logger = require("../utils/logger");

const isEnabled = () => /^(1|true|yes)$/i.test(String(process.env.PERF_LOG || ""));
const msSince = (start) => Number(process.hrtime.bigint() - start) / 1e6;

const perfMiddleware = (req, res, next) => {
  if (!isEnabled()) return next();

  const startedAt = process.hrtime.bigint();
  let segmentStartedAt = startedAt;
  let completed = false;
  let handlerMarked = false;
  const segments = [];

  req.perfMark = (name) => {
    const now = process.hrtime.bigint();
    segments.push({ name, ms: Math.round(Number(now - segmentStartedAt) / 1e6) });
    segmentStartedAt = now;
  };

  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    if (!handlerMarked) {
      req.perfMark("handler/db");
      handlerMarked = true;
    }
    const serializationStart = process.hrtime.bigint();
    res.setHeader("Server-Timing", segments.map((item) => `${item.name.replace(/[^a-z0-9_-]/gi, "_")};dur=${item.ms}`).join(", "));
    const result = originalJson(payload);
    const now = process.hrtime.bigint();
    segments.push({ name: "serialization", ms: Math.round(Number(now - serializationStart) / 1e6) });
    segmentStartedAt = now;
    return result;
  };

  res.once("finish", () => {
    if (completed) return;
    completed = true;
    if (!handlerMarked) req.perfMark("handler/db");
    segments.push({ name: "response_flush", ms: Math.round(msSince(segmentStartedAt)) });
    const totalMs = Math.round(msSince(startedAt));
    logger.info("Request performance", {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      totalMs,
      segments,
    });
  });

  next();
};

module.exports = perfMiddleware;
