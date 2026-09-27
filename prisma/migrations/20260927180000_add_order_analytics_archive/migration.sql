CREATE TABLE "OrderAnalyticsArchive" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "day" DATE NOT NULL,
  "totalOrders" INTEGER NOT NULL DEFAULT 0,
  "statusCounts" JSONB NOT NULL DEFAULT '{}',
  "hourCounts" JSONB NOT NULL DEFAULT '{}',
  "sizeStats" JSONB NOT NULL DEFAULT '{}',
  "debtStats" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OrderAnalyticsArchive_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderArchiveRun" (
  "key" TEXT NOT NULL,
  "selectionHash" TEXT NOT NULL,
  "selectedCount" INTEGER NOT NULL,
  "firstCreatedAt" TIMESTAMP(3) NOT NULL,
  "lastCreatedAt" TIMESTAMP(3) NOT NULL,
  "liveCountBefore" INTEGER NOT NULL,
  "liveCountAfter" INTEGER NOT NULL,
  "combinedCountBefore" INTEGER NOT NULL,
  "combinedCountAfter" INTEGER NOT NULL,
  "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OrderArchiveRun_pkey" PRIMARY KEY ("key")
);

CREATE UNIQUE INDEX "OrderAnalyticsArchive_branchId_day_key"
  ON "OrderAnalyticsArchive"("branchId", "day");

CREATE INDEX "OrderAnalyticsArchive_day_idx"
  ON "OrderAnalyticsArchive"("day");

ALTER TABLE "OrderAnalyticsArchive"
  ADD CONSTRAINT "OrderAnalyticsArchive_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
