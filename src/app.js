require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const prisma = require("./config/prisma");
const authMiddleware = require("./middleware/auth.middleware");
const { notFound, errorMiddleware } = require("./middleware/error.middleware");
const perfMiddleware = require("./middleware/perf.middleware");

const authRoutes = require("./routes/auth.routes");
const branchRoutes = require("./routes/branch.routes");
const userRoutes = require("./routes/user.routes");
const lockerRoutes = require("./routes/locker.routes");
const orderRoutes = require("./routes/order.routes");
const debtRoutes = require("./routes/debt.routes");
const shiftRoutes = require("./routes/shift.routes");
const expenseRoutes = require("./routes/expense.routes");
const inkassaRoutes = require("./routes/inkassa.routes");
const cashMovementRoutes = require("./routes/cashMovement.routes");
const tariffRoutes = require("./routes/tariff.routes");
const notificationRoutes = require("./routes/notification.routes");
const analyticsRoutes = require("./routes/analytics.routes");
const telegramRoutes = require("./routes/telegram.routes");
const exportRoutes = require("./routes/export.routes");
const auditRoutes = require("./routes/audit.routes");
const systemRoutes = require("./routes/system.routes");
const googleSheetsRoutes = require("./routes/googleSheets.routes");

const app = express();
const perfLoggingEnabled = /^(1|true|yes)$/i.test(String(process.env.PERF_LOG || ""));
const isDevelopment = process.env.NODE_ENV === "development";
const parseEnvInt = (name, fallback, min, max) => {
  const value = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};

const productionFrontendOrigins = [
  "https://qonoqbaggage.uz",
  "https://www.qonoqbaggage.uz",
];

const allowedOrigins = [
  ...(process.env.FRONTEND_URL || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  ...productionFrontendOrigins,
].filter((origin, index, list) => origin && list.indexOf(origin) === index);

const isLocalDevelopmentOrigin = (origin = "") =>
  process.env.NODE_ENV !== "production" &&
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

app.set("trust proxy", 1);
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (
        !origin ||
        allowedOrigins.includes(origin) ||
        isLocalDevelopmentOrigin(origin) ||
        (process.env.NODE_ENV !== "production" && allowedOrigins.length === 0)
      ) {
        return callback(null, true);
      }
      const error = new Error("Not allowed by CORS");
      error.statusCode = 403;
      return callback(error);
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: parseEnvInt("API_RATE_LIMIT_MAX", 3000, 100, 100000),
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "OPTIONS" || req.path === "/health" || req.path === "/ready",
    message: {
      success: false,
      message: "Juda ko'p so'rov yuborildi. Iltimos, birozdan keyin qayta urinib ko'ring.",
    },
  })
);

const productionMorganFormat = (tokens, req, res) => [
  tokens.method(req),
  req.path,
  tokens.status(req, res),
  `${tokens["response-time"](req, res)} ms`,
].join(" ");

app.use(
  morgan(
    isDevelopment ? "dev" : productionMorganFormat,
    {
      skip: (req) => req.path.startsWith("/api/auth/login")
        || req.path === "/health"
        || req.path === "/ready"
        || (!isDevelopment && !perfLoggingEnabled),
    },
  )
);

app.get("/health", (_req, res) => res.json({ success: true, data: { status: "ok" } }));
app.get("/ready", async (_req, res) => {
  let timeoutId = null;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Database readiness timeout")), 4000);
      }),
    ]);
    return res.json({ success: true, data: { status: "ready" } });
  } catch {
    return res.status(503).json({ success: false, data: { status: "not_ready" } });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
});
app.use(perfMiddleware);
app.use("/api/auth", authRoutes);

app.use(authMiddleware);
app.use("/api/branches", branchRoutes);
app.use("/api/users", userRoutes);
app.use("/api/lockers", lockerRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/debts", debtRoutes);
app.use("/api/shifts", shiftRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/inkassa", inkassaRoutes);
app.use("/api/cash-movements", cashMovementRoutes);
app.use("/api/tariffs", tariffRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/telegram", telegramRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/export", exportRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/system", systemRoutes);
app.use("/api/google-sheets", googleSheetsRoutes);

app.use(notFound);
app.use(errorMiddleware);

module.exports = app;
