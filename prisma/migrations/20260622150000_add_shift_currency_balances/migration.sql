ALTER TABLE "Shift"
  ADD COLUMN IF NOT EXISTS "openingCashByCurrency" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "acceptedCashByCurrency" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "closingCashByCurrency" JSONB,
  ADD COLUMN IF NOT EXISTS "differenceByCurrency" JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE "Shift"
SET
  "openingCashByCurrency" = jsonb_build_object('UZS', "openingCash"),
  "acceptedCashByCurrency" = jsonb_build_object('UZS', "acceptedCash"),
  "closingCashByCurrency" = CASE
    WHEN "closingCash" IS NULL THEN NULL
    ELSE jsonb_build_object('UZS', "closingCash")
  END,
  "differenceByCurrency" = jsonb_build_object('UZS', "difference")
WHERE "openingCashByCurrency" = '{}'::jsonb
   OR "acceptedCashByCurrency" = '{}'::jsonb;
