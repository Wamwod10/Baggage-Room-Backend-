const test = require("node:test");
const assert = require("node:assert/strict");
const { requireIdempotencyKey, isUniqueConflictFor } = require("../src/utils/idempotency");

test("critical mutations require a bounded idempotency key", () => {
  assert.throws(() => requireIdempotencyKey(""), (error) => error.statusCode === 400);
  assert.equal(requireIdempotencyKey(`  ${"x".repeat(140)}  `).length, 120);
});

test("Prisma unique conflicts are matched only to the requested key", () => {
  const error = { code: "P2002", meta: { target: ["idempotencyKey"] } };
  assert.equal(isUniqueConflictFor(error, "idempotencyKey"), true);
  assert.equal(isUniqueConflictFor(error, "closeIdempotencyKey"), false);
});
