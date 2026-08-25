const { AppError } = require("./response");

const requireIdempotencyKey = (value) => {
  const key = String(value || "").trim().slice(0, 120);
  if (!key) {
    throw new AppError("Idempotency-Key header is required", 400, [
      { field: "Idempotency-Key", message: "Idempotency-Key header is required" },
    ]);
  }
  return key;
};

const isUniqueConflictFor = (error, field) => {
  if (error?.code !== "P2002") return false;
  const target = Array.isArray(error?.meta?.target)
    ? error.meta.target.join(",")
    : String(error?.meta?.target || "");
  return target.includes(field);
};

module.exports = { requireIdempotencyKey, isUniqueConflictFor };
