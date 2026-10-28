-- Nullable, additive columns keep all historical payment values unchanged.
ALTER TABLE "CashMovement" ADD COLUMN "fxRate" DECIMAL(20,8);
ALTER TABLE "CashMovement" ADD COLUMN "fxRateDate" DATE;
ALTER TABLE "CashMovement" ADD COLUMN "uzsEquivalent" DECIMAL(20,0);
