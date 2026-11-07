-- Additive FX metadata: keep historical native currency amounts and cash ledgers intact.
ALTER TABLE "Order"
  ADD COLUMN "calculatedAmountUZS" INTEGER,
  ADD COLUMN "paymentAmountForeignMinor" INTEGER,
  ADD COLUMN "exchangeRate" DECIMAL(22, 10);

UPDATE "Order" SET "calculatedAmountUZS" = "calculatedAmount"
WHERE "currency" = 'UZS';

UPDATE "Order" SET
  "paymentAmountForeignMinor" = "realPaidAmount",
  "exchangeRate" = CASE
    WHEN ("pricingSnapshot"->>'exchangeRate') ~ '^[0-9]+([.][0-9]+)?$'
      AND ("pricingSnapshot"->>'exchangeRate')::numeric > 0
    THEN ("pricingSnapshot"->>'exchangeRate')::numeric(22, 10)
    ELSE NULL END
WHERE "currency" <> 'UZS';
