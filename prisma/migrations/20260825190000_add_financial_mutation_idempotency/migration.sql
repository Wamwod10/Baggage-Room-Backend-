-- Additive, nullable keys make retries safe without rewriting historical rows.
ALTER TABLE "Shift" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
ALTER TABLE "Shift" ADD COLUMN IF NOT EXISTS "closeIdempotencyKey" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
ALTER TABLE "Inkassa" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "editIdempotencyKey" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "pickupIdempotencyKey" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "cancelIdempotencyKey" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "transferIdempotencyKey" TEXT;
ALTER TABLE "Locker" ADD COLUMN IF NOT EXISTS "actionIdempotencyKey" TEXT;
ALTER TABLE "Debt" ADD COLUMN IF NOT EXISTS "closeIdempotencyKey" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "Shift_idempotencyKey_key" ON "Shift"("idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "Shift_closeIdempotencyKey_key" ON "Shift"("closeIdempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "Expense_idempotencyKey_key" ON "Expense"("idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "Inkassa_idempotencyKey_key" ON "Inkassa"("idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "Order_editIdempotencyKey_key" ON "Order"("editIdempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "Order_pickupIdempotencyKey_key" ON "Order"("pickupIdempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "Order_cancelIdempotencyKey_key" ON "Order"("cancelIdempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "Order_transferIdempotencyKey_key" ON "Order"("transferIdempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "Locker_actionIdempotencyKey_key" ON "Locker"("actionIdempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "Debt_closeIdempotencyKey_key" ON "Debt"("closeIdempotencyKey");
