-- Safe additive migration for idempotent order creation, critical-action
-- concurrency, and the query patterns used by the 24/7 dashboard.
-- Fail before any DDL if the partial unique index would reject existing data.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Shift"
    WHERE "status" = 'OPEN'
    GROUP BY "branchId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot create Shift_one_open_per_branch_idx: duplicate OPEN shifts exist. Reconcile them before deploying this migration.';
  END IF;
END $$;

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Order_idempotencyKey_key" ON "Order"("idempotencyKey");

CREATE INDEX IF NOT EXISTS "Order_branchId_phone_status_createdAt_idx"
  ON "Order"("branchId", "phone", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "Order_branchId_passport_status_createdAt_idx"
  ON "Order"("branchId", "passport", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "Locker_currentOrderId_idx"
  ON "Locker"("currentOrderId");
CREATE INDEX IF NOT EXISTS "Notification_branchId_isRead_priority_createdAt_idx"
  ON "Notification"("branchId", "isRead", "priority", "createdAt");
CREATE INDEX IF NOT EXISTS "Notification_isRead_priority_createdAt_idx"
  ON "Notification"("isRead", "priority", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_branchId_createdAt_idx"
  ON "AuditLog"("branchId", "createdAt");
CREATE INDEX IF NOT EXISTS "Expense_branchId_createdAt_idx"
  ON "Expense"("branchId", "createdAt");
CREATE INDEX IF NOT EXISTS "Inkassa_branchId_createdAt_idx"
  ON "Inkassa"("branchId", "createdAt");

-- Only one open shift is valid per branch. This prevents two operators from
-- opening the same branch concurrently without restricting historical shifts.
CREATE UNIQUE INDEX IF NOT EXISTS "Shift_one_open_per_branch_idx"
  ON "Shift"("branchId")
  WHERE "status" = 'OPEN';
