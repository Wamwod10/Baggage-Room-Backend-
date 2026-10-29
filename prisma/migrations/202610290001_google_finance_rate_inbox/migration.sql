-- Additive Google Finance snapshot inbox; no old cash/order records are modified.
CREATE TABLE "GoogleFinanceRateInbox" (
  "day" VARCHAR(10) NOT NULL PRIMARY KEY,
  "rates" JSONB NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
