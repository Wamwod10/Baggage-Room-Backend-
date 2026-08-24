const { Prisma } = require("@prisma/client");
const { fail } = require("../utils/response");
const logger = require("../utils/logger");

const notFound = (req, _res, next) => {
  const error = new Error(`Route not found: ${req.method} ${req.path}`);
  error.statusCode = 404;
  next(error);
};

const errorMiddleware = (err, _req, res, _next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || "Internal server error";
  let errors = err.errors || [];

  if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
    statusCode = 401;
    message = "Invalid or expired token";
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    statusCode = 400;
    message = "Database request failed";
    errors = [{ code: err.code, meta: err.meta }];
  }

  logger.error("Request failed", {
    method: _req.method,
    path: _req.path,
    statusCode,
    message,
    ...(process.env.NODE_ENV !== "production" ? { stack: err.stack } : {}),
  });

  return fail(res, message, statusCode, errors);
};

module.exports = { notFound, errorMiddleware };
