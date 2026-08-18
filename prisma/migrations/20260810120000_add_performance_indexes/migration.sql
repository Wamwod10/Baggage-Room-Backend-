-- Query-pattern indexes for order lists, active/debt filters, and analytics summaries.
CREATE INDEX IF NOT EXISTS "Order_branchId_createdAt_idx" ON "Order"("branchId", "createdAt");
CREATE INDEX IF NOT EXISTS "Order_branchId_status_createdAt_idx" ON "Order"("branchId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "Order_branchId_status_plannedCheckOut_idx" ON "Order"("branchId", "status", "plannedCheckOut");
CREATE INDEX IF NOT EXISTS "Order_status_plannedCheckOut_idx" ON "Order"("status", "plannedCheckOut");
CREATE INDEX IF NOT EXISTS "Order_branchId_paymentType_createdAt_idx" ON "Order"("branchId", "paymentType", "createdAt");
CREATE INDEX IF NOT EXISTS "Order_branchId_orderNumber_idx" ON "Order"("branchId", "orderNumber");

CREATE INDEX IF NOT EXISTS "Locker_branchId_status_idx" ON "Locker"("branchId", "status");

CREATE INDEX IF NOT EXISTS "Shift_branchId_status_openedAt_idx" ON "Shift"("branchId", "status", "openedAt");

CREATE INDEX IF NOT EXISTS "CashMovement_orderId_idx" ON "CashMovement"("orderId");
CREATE INDEX IF NOT EXISTS "CashMovement_branchId_createdAt_idx" ON "CashMovement"("branchId", "createdAt");
CREATE INDEX IF NOT EXISTS "CashMovement_branchId_type_createdAt_idx" ON "CashMovement"("branchId", "type", "createdAt");
CREATE INDEX IF NOT EXISTS "CashMovement_shiftId_createdAt_idx" ON "CashMovement"("shiftId", "createdAt");

CREATE INDEX IF NOT EXISTS "Debt_branchId_status_createdAt_idx" ON "Debt"("branchId", "status", "createdAt");
