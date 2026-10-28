-- Additive and forward-only. Old movements are untouched (NULL FX fields).
ALTER TABLE "CashMovement"
  ADD COLUMN "fxRate" TEXT,
  ADD COLUMN "fxRateDate" TEXT,
  ADD COLUMN "fxNominal" INTEGER,
  ADD COLUMN "fxSource" TEXT,
  ADD COLUMN "uzsEquivalent" INTEGER;
