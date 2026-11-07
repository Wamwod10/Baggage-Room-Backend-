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

-- Recover UZS tariff baseline from the original per-order tariff snapshot,
-- only where a fixed package and all item prices are unambiguous.
WITH original_tariffs AS (
  SELECT o.id, i.count,
    CASE
      WHEN o."tariffHours" <= 1 THEN o."pricingSnapshot"->'tariffs'->(i.size::text)->>'price1h'
      WHEN o."tariffHours" <= 12 THEN o."pricingSnapshot"->'tariffs'->(i.size::text)->>'price12h'
      WHEN o."tariffHours" <= 24 THEN o."pricingSnapshot"->'tariffs'->(i.size::text)->>'price24h'
      WHEN o."tariffHours" <= 48 THEN o."pricingSnapshot"->'tariffs'->(i.size::text)->>'price48h'
      WHEN o."tariffHours" <= 72 THEN o."pricingSnapshot"->'tariffs'->(i.size::text)->>'price72h'
      ELSE NULL END AS price_text
  FROM "Order" o
  JOIN "OrderItem" i ON i."orderId" = o.id
  WHERE o."currency" <> 'UZS'
    AND o."customHours" IS NULL
    AND o."tariffHours" BETWEEN 1 AND 72
    AND jsonb_typeof(o."pricingSnapshot"->'tariffs') = 'object'
), prices AS (
  SELECT id, COUNT(*) AS item_count,
    COUNT(*) FILTER (WHERE price_text ~ '^[0-9]{1,9}$' AND count > 0) AS valid_count,
    SUM(CASE WHEN price_text ~ '^[0-9]{1,9}$' THEN price_text::bigint * count ELSE 0 END) AS tariff_uzs
  FROM original_tariffs GROUP BY id
)
UPDATE "Order" o SET "calculatedAmountUZS" = p.tariff_uzs::integer
FROM prices p WHERE o.id = p.id AND p.item_count > 0
  AND p.valid_count = p.item_count AND p.tariff_uzs BETWEEN 0 AND 2147483647;
