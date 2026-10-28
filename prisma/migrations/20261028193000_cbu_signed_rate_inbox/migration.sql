-- Additive official CBU feed inbox. No existing order or cash movement is changed.
CREATE TABLE "CbuRateInbox" (
  "day" VARCHAR(10) NOT NULL PRIMARY KEY,
  "officialRows" JSONB NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
