-- Additive indexes for the current-shift operator dashboard.
CREATE INDEX IF NOT EXISTS "Order_branchId_createdById_createdAt_idx" ON "Order"("branchId", "createdById", "createdAt");
CREATE INDEX IF NOT EXISTS "Order_branchId_pickedUpById_realPickupTime_idx" ON "Order"("branchId", "pickedUpById", "realPickupTime");
CREATE INDEX IF NOT EXISTS "Order_branchId_cancelledById_cancelledAt_idx" ON "Order"("branchId", "cancelledById", "cancelledAt");
CREATE INDEX IF NOT EXISTS "Debt_branchId_closedById_closedAt_idx" ON "Debt"("branchId", "closedById", "closedAt");
CREATE INDEX IF NOT EXISTS "AuditLog_branchId_userId_action_createdAt_idx" ON "AuditLog"("branchId", "userId", "action", "createdAt");
CREATE INDEX IF NOT EXISTS "CashMovement_shiftId_createdById_createdAt_idx" ON "CashMovement"("shiftId", "createdById", "createdAt");
