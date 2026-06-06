require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const authMiddleware = require("./middleware/auth.middleware");
const { notFound, errorMiddleware } = require("./middleware/error.middleware");

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

const app = express();

const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.set("trust proxy", 1);
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin) || (process.env.NODE_ENV !== "production" && allowedOrigins.length === 0)) {
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
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);
app.use(
  morgan(process.env.NODE_ENV === "production" ? "combined" : "dev", {
    skip: (req) => req.path.startsWith("/api/auth/login"),
  })
);

app.get("/health", (_req, res) => res.json({ success: true, data: { status: "ok" } }));
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

app.use(notFound);
app.use(errorMiddleware);

module.exports = app;
