-- Additive only: existing orders retain legacy pricing; no historical backfill.
ALTER TABLE "Order" ADD COLUMN "pricingSnapshot" JSONB;
ALTER TABLE "Order" ADD COLUMN "priceApprovedById" TEXT REFERENCES "User"("id");
ALTER TABLE "Order" ADD COLUMN "priceApprovedByName" TEXT;
ALTER TABLE "CashMovement" ADD COLUMN "financialKind" TEXT;
ALTER TABLE "CashMovement" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "CashMovement_idempotencyKey_key" ON "CashMovement"("idempotencyKey");
CREATE TABLE "FinancialRequest" (
 "id" TEXT PRIMARY KEY, "idempotencyKey" TEXT NOT NULL UNIQUE,
 "orderId" TEXT NOT NULL REFERENCES "Order"("id"), "branchId" TEXT NOT NULL REFERENCES "Branch"("id"),
 "requestedById" TEXT NOT NULL REFERENCES "User"("id"),
 "kind" TEXT NOT NULL CHECK ("kind" IN ('REFUND', 'PAYMENT_CORRECTION')),
 "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','REJECTED','APPROVED_AWAITING_PAYOUT','EXECUTED')),
 "movementId" TEXT NOT NULL REFERENCES "CashMovement"("id"),
 "amount" INTEGER NOT NULL CHECK ("amount" > 0), "currency" "Currency" NOT NULL,
 "oldPaymentType" "PaymentType" NOT NULL, "newPaymentType" "PaymentType",
 "reason" TEXT NOT NULL CHECK (length(trim("reason")) > 0), "context" JSONB NOT NULL,
 "decidedById" TEXT REFERENCES "User"("id"), "telegramUserId" TEXT, "decidedAt" TIMESTAMP(3),
 "payoutById" TEXT REFERENCES "User"("id"), "paidAt" TIMESTAMP(3), "payoutReference" TEXT, "payoutPaymentType" "PaymentType", "payoutIdempotencyKey" TEXT UNIQUE,
 "messageId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "FinancialRequest_orderId_status_idx" ON "FinancialRequest"("orderId", "status");
CREATE TABLE "FinancialOutbox" (
 "id" TEXT PRIMARY KEY, "deliveryKey" TEXT NOT NULL UNIQUE, "requestId" TEXT REFERENCES "FinancialRequest"("id"),
 "action" TEXT NOT NULL, "payload" JSONB, "attempts" INTEGER NOT NULL DEFAULT 0,
 "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "deliveredAt" TIMESTAMP(3), "lastError" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "FinancialOutbox_deliveredAt_availableAt_idx" ON "FinancialOutbox"("deliveredAt", "availableAt");
