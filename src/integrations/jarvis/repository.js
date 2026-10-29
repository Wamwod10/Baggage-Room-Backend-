const { Prisma } = require('@prisma/client');
const { serializeRecord, serializeSales, serializeCash } = require('./serializers');
const { CURRENCIES } = require('./query');

const common = { id: true, createdAt: true, updatedAt: true, branch: { select: { code: true } } };
const resources = {
  branches: { model: 'branch', dateField: 'createdAt', select: { id: true, code: true, name: true, isActive: true, createdAt: true, updatedAt: true } },
  orders: { model: 'order', dateField: 'createdAt', select: { ...common, orderNumber: true, status: true, currency: true, paymentType: true, calculatedAmount: true, discountAmount: true, finalAmount: true, realPaidAmount: true, overtimeAmount: true, overtimePaymentType: true, pricingSnapshot: true, checkIn: true, plannedCheckOut: true, realPickupTime: true, cancelledAt: true, items: { select: { size: true, count: true } } } },
  transactions: { model: 'cashMovement', dateField: 'createdAt', select: { ...common, type: true, direction: true, amount: true, currency: true, paymentType: true, orderId: true, shiftId: true, financialKind: true, fxRate: true, fxRateDate: true, fxNominal: true, fxSource: true, uzsEquivalent: true } },
  shifts: { model: 'shift', dateField: 'openedAt', select: { ...common, status: true, openedAt: true, closedAt: true, openingCash: true, acceptedCash: true, closingCash: true, openingCashByCurrency: true, acceptedCashByCurrency: true, closingCashByCurrency: true, differenceByCurrency: true } },
  expenses: { model: 'expense', dateField: 'createdAt', select: { ...common, amount: true, currency: true, category: true, shiftId: true } },
  inkassa: { model: 'inkassa', dateField: 'createdAt', select: { ...common, amount: true, currency: true, shiftId: true } },
};
const pagination = (filters, total) => ({ page: filters.page, limit: filters.limit, total: Number(total), totalPages: Math.ceil(Number(total) / filters.limit) });

// Bound expensive reports before taking a pool connection; other endpoints keep their pool access.
// Per-client/process, FIFO, at most 2 active + 16 waiting. Queueing never changes the report range.
const salesGates = new WeakMap();
async function acquireSales(client) {
  let gate = salesGates.get(client);
  if (!gate) { gate = { active: 0, queue: [] }; salesGates.set(client, gate); }
  if (gate.active < 2) gate.active++;
  else {
    if (gate.queue.length >= 16) throw new Error('Sales capacity exceeded');
    await new Promise((resolve, reject) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        gate.queue.splice(gate.queue.indexOf(entry), 1);
        reject(new Error('Sales queue timeout'));
      }, 5000);
      gate.queue.push(entry);
    });
  }
  return () => {
    const next = gate.queue.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); }
    else gate.active--;
  };
}

async function records(tx, endpoint, filters) {
  const { model, dateField, select } = resources[endpoint];
  const where = {
    ...(filters.branchCode ? (endpoint === 'branches' ? { code: filters.branchCode } : { branch: { code: filters.branchCode } }) : {}),
    ...(filters.from || filters.to ? { [dateField]: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } } : {}),
    ...(filters.currency ? { currency: filters.currency } : {}),
    ...(filters.paymentType && ['orders', 'transactions'].includes(endpoint) ? { paymentType: filters.paymentType } : {}),
  };
  const total = await tx[model].count({ where });
  const rows = await tx[model].findMany({ where, select, take: filters.limit, skip: filters.skip, orderBy: [{ [dateField]: 'asc' }, { id: 'asc' }] });
  return { data: rows.map(row => serializeRecord(endpoint, row)), pagination: pagination(filters, total), ...(endpoint === 'orders' ? { coverage: 'LIVE_ORDERS_ONLY' } : {}) };
}

function salesCte(f) {
  return Prisma.sql`WITH ledger_groups AS MATERIALIZED (
    SELECT m."branchId",
      (m."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tashkent')::date AS day,
      m."currency", m."paymentType",
      SUM(CASE WHEN m."financialKind" = 'PAYMENT_CORRECTION' AND m."direction" = 'OUT' THEN -m."amount"::bigint
        WHEN m."direction" = 'IN' THEN m."amount"::bigint ELSE 0 END)::text AS "grossReceipts",
      SUM(CASE WHEN m."direction" = 'OUT' AND m."financialKind" IS DISTINCT FROM 'PAYMENT_CORRECTION' THEN m."amount"::bigint ELSE 0 END)::text AS refunds,
      SUM(CASE WHEN m."direction" = 'IN' THEN m."amount"::bigint ELSE -m."amount"::bigint END)::text AS "netReceipts",
      COUNT(*)::bigint AS "transactionCount", MIN(m."createdAt") AS "createdAt", MAX(m."updatedAt") AS "updatedAt"
    FROM "CashMovement" m JOIN "Branch" b ON b.id = m."branchId"
    WHERE m.type IN ('ORDER_PAYMENT', 'DEBT_CLOSE') AND m."paymentType" IS NOT NULL AND m."paymentType" <> 'DEBT'
      AND (${f.branchCode || null}::text IS NULL OR b.code = ${f.branchCode || null})
      AND (${f.from || null}::timestamp IS NULL OR m."createdAt" >= ${f.from || null})
      AND (${f.to || null}::timestamp IS NULL OR m."createdAt" <= ${f.to || null})
      AND (${f.currency || null}::text IS NULL OR m.currency::text = ${f.currency || null})
      AND (${f.paymentType || null}::text IS NULL OR m."paymentType"::text = ${f.paymentType || null})
    GROUP BY m."branchId", day, m.currency, m."paymentType"
  ), report AS MATERIALIZED (
    SELECT b.code AS "branchCode", to_char(g.day, 'YYYY-MM-DD') AS day,
      g.currency::text AS currency, g."paymentType"::text AS "paymentType",
      g."grossReceipts", g.refunds, g."netReceipts", g."transactionCount", g."createdAt", g."updatedAt"
    FROM ledger_groups g JOIN "Branch" b ON b.id = g."branchId"
  )`;
}

async function sales(tx, filters) {
  const cte = salesCte(filters);
  // Reuse one ledger aggregation for both count and page, including empty/out-of-range pages.
  const rows = await tx.$queryRaw(Prisma.sql`${cte},
    totals AS (SELECT COUNT(*)::bigint AS total FROM report),
    page AS (SELECT * FROM report ORDER BY day, "branchCode", currency, "paymentType" LIMIT ${filters.limit} OFFSET ${filters.skip})
    SELECT totals.total, page.* FROM totals LEFT JOIN page ON true
    ORDER BY page.day, page."branchCode", page.currency, page."paymentType"`);
  return { data: rows.filter(row => row.branchCode != null).map(serializeSales), pagination: pagination(filters, rows[0].total) };
}

async function cash(tx, f) {
  const asOf = f.to || new Date();
  const where = { ...(f.branchCode ? { code: f.branchCode } : {}), createdAt: { lte: asOf } };
  const total = await tx.branch.count({ where }) * (f.currency ? 1 : CURRENCIES.length);
  const rows = await tx.$queryRaw(Prisma.sql`
    SELECT b.id, b.code AS "branchCode", c.currency, s.id AS "shiftId",
      COALESCE((s."openingCashByCurrency" ->> c.currency)::bigint, CASE WHEN c.currency = 'UZS' THEN s."openingCash" ELSE 0 END, 0)::text AS opening,
      COALESCE((s."acceptedCashByCurrency" ->> c.currency)::bigint, CASE WHEN c.currency = 'UZS' THEN s."acceptedCash" ELSE 0 END, 0)::text AS accepted,
      COALESCE(m.net, 0)::text AS "movementNet", b."createdAt",
      GREATEST(b."updatedAt", s."updatedAt", m.updated) AS "updatedAt"
    FROM "Branch" b CROSS JOIN unnest(ARRAY['UZS','USD','RUB','EUR','KZT','TJS']) AS c(currency)
    LEFT JOIN LATERAL (
      SELECT id, "openedAt", "openingCash", "acceptedCash", "openingCashByCurrency", "acceptedCashByCurrency", "updatedAt"
      FROM "Shift" WHERE "branchId" = b.id AND "openedAt" <= ${asOf} ORDER BY "openedAt" DESC, id DESC LIMIT 1
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT SUM(CASE WHEN cm.direction = 'IN' THEN cm.amount::bigint ELSE -cm.amount::bigint END) AS net, MAX(cm."updatedAt") AS updated
      FROM "CashMovement" cm
      WHERE cm."branchId" = b.id AND cm.currency::text = c.currency AND cm."createdAt" <= ${asOf}
        AND (s.id IS NULL OR cm."createdAt" >= s."openedAt")
        AND (
          (cm.type IN ('ORDER_PAYMENT', 'DEBT_CLOSE') AND cm."paymentType" = 'CASH')
          OR (cm.type IN ('EXPENSE', 'INKASSA') AND cm.direction = 'OUT')
          OR (cm.type = 'MANUAL_CORRECTION' AND (cm."paymentType" IS NULL OR cm."paymentType" = 'CASH'))
        )
    ) m ON true
    WHERE b."createdAt" <= ${asOf} AND (${f.branchCode || null}::text IS NULL OR b.code = ${f.branchCode || null})
      AND (${f.currency || null}::text IS NULL OR c.currency = ${f.currency || null})
    ORDER BY b.code, c.currency LIMIT ${f.limit} OFFSET ${f.skip}
  `);
  return { data: rows.map(row => serializeCash(row, asOf)), pagination: pagination(f, total), asOf: asOf.toISOString(), reconstruction: 'CURRENT_LEDGER_WITH_LATEST_SHIFT_BASELINE' };
}

async function getJarvisData(client, endpoint, filters) {
  const release = endpoint === 'sales' ? await acquireSales(client) : null;
  try { return await client.$transaction(async tx => {
    // Defense in depth even when a dedicated read-only DB role is not yet provisioned.
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '8000ms'`;
    if (endpoint === 'sales') return sales(tx, filters);
    if (endpoint === 'cash-balances') return cash(tx, filters);
    return records(tx, endpoint, filters);
  }, { isolationLevel: 'RepeatableRead', timeout: 10000, maxWait: 5000 });
  } finally { if (release) release(); }
}

module.exports = { getJarvisData };
