WITH tia AS (
  SELECT "id"
  FROM "Branch"
  WHERE "code" = 'TIA'
)
UPDATE "Locker"
SET "size" = 'L'::"LockerSize"
WHERE "branchId" IN (SELECT "id" FROM tia)
  AND "number" IN (
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    21, 22, 23, 24, 25, 26, 27, 28, 29,
    33, 34, 35, 36
  );

WITH tia AS (
  SELECT "id"
  FROM "Branch"
  WHERE "code" = 'TIA'
)
UPDATE "Locker"
SET "size" = 'S'::"LockerSize"
WHERE "branchId" IN (SELECT "id" FROM tia)
  AND "number" IN (30, 31, 32, 37, 38, 39);

WITH tia AS (
  SELECT "id"
  FROM "Branch"
  WHERE "code" = 'TIA'
)
UPDATE "Locker"
SET "size" = 'M'::"LockerSize"
WHERE "branchId" IN (SELECT "id" FROM tia)
  AND "number" BETWEEN 40 AND 45;
