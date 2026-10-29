const { Prisma } = require("@prisma/client");
const prisma = require("../config/prisma");
const { dateRangeWhere } = require("../utils/date");

const loadMovementFacts = async ({ branchId, dateFrom, dateTo } = {}, client = prisma) => {
  const range = dateRangeWhere(dateFrom, dateTo).createdAt || {};
  const rows = await client.$queryRaw(Prisma.sql`
    SELECT m."branchId",
           m."shiftId",
           m."type"::text AS "type",
           m."direction"::text AS "direction",
           COALESCE(SUM(m."amount"), 0)::bigint AS "amount",
           SUM(m."uzsEquivalent")::bigint AS "uzsEquivalent",
           COUNT(*) FILTER (WHERE m."currency" <> 'UZS' AND m."uzsEquivalent" IS NULL AND m."type"::text IN ('ORDER_PAYMENT', 'DEBT_CLOSE'))::int AS "missingFxCount",
           m."currency"::text AS "currency",
           m."paymentType"::text AS "paymentType",
           m."createdById",
           to_char((m."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tashkent')::date, 'YYYY-MM-DD') AS "day",
           (COALESCE(m."note", '') LIKE 'Oylik:%') AS "isSalary",
           COUNT(*)::int AS "count"
    FROM "CashMovement" m
    WHERE (${branchId || null}::text IS NULL OR m."branchId" = ${branchId || null})
      AND (${range.gte || null}::timestamp IS NULL OR m."createdAt" >= ${range.gte || null})
      AND (${range.lte || null}::timestamp IS NULL OR m."createdAt" <= ${range.lte || null})
    GROUP BY m."branchId", m."shiftId", m."type", m."direction", m."currency",
             m."paymentType", m."createdById", "day", "isSalary"
  `);

  return rows.map((row) => ({
    ...row,
    amount: Number(row.amount || 0),
    uzsEquivalent: row.uzsEquivalent == null ? null : Number(row.uzsEquivalent),
    missingFxCount: Number(row.missingFxCount || 0),
    count: Number(row.count || 0),
    isSalary: Boolean(row.isSalary),
  }));
};

module.exports = { loadMovementFacts };
