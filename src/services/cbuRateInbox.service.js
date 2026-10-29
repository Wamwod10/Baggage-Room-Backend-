const crypto = require('node:crypto');
const { AppError } = require('../utils/response');

const WINDOW_MS = 5 * 60 * 1000;
const FEED_MAX_AGE_MS = 26 * 60 * 60 * 1000;
const CURRENCIES = new Set(['USD', 'EUR', 'RUB', 'KZT', 'TJS']);
const getSecret = () => String(process.env.CBU_SYNC_SHARED_SECRET || '');

function verifySignedRequest(raw, timestamp, signature, secret = getSecret(), now = Date.now()) {
  if (!secret || Buffer.byteLength(secret) < 32) throw new AppError('CBU sync is not configured', 503);
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > 65536) throw new AppError('Invalid CBU sync payload', 400);
  if (!/^\d{13}$/.test(String(timestamp || '')) || Math.abs(now - Number(timestamp)) > WINDOW_MS) {
    throw new AppError('Invalid CBU sync authentication', 401);
  }
  const expected = crypto.createHmac('sha256', secret).update(String(timestamp)).update('.').update(raw).digest('hex');
  const supplied = String(signature || '').replace(/^sha256=/i, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(supplied) || !crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new AppError('Invalid CBU sync authentication', 401);
  }
  return true;
}

function validateEnvelope(body, now = new Date()) {
  const { tashkentDate, _internals } = require('./cbuRates.service');
  if (!body || body.source !== 'CBU' || !Array.isArray(body.rates) || body.rates.length < CURRENCIES.size || body.rates.length > 100) {
    throw new AppError('Invalid CBU sync payload', 400);
  }
  if (!body.rates.every(row => row && CURRENCIES.has(row.Ccy) && Object.keys(row).every(key => ['Ccy','Rate','Nominal','Date'].includes(key)))) {
    throw new AppError('CBU sync has unsupported fields or currencies', 400);
  }
  if (new Set(body.rates.map(row => row.Ccy)).size !== CURRENCIES.size || body.rates.length !== CURRENCIES.size) {
    throw new AppError('CBU sync currency set is incomplete or duplicated', 400);
  }
  const fetchedTime = Date.parse(body.fetchedAt || '');
  if (!Number.isFinite(fetchedTime) || Math.abs(now.getTime() - fetchedTime) > WINDOW_MS) {
    throw new AppError('CBU sync timestamp is stale', 401);
  }
  const day = tashkentDate(now);
  try { _internals.validateRates(body.rates, day); }
  catch { throw new AppError('Invalid official CBU rate effective date or nominal', 400); }
  return { day, rates: body.rates, fetchedAt: new Date(fetchedTime) };
}

async function acceptSignedEnvelope(raw, headers, { now = new Date(), prisma = require('../config/prisma') } = {}) {
  const timestamp = headers['x-cbu-sync-timestamp'];
  const signature = headers['x-cbu-sync-signature'];
  verifySignedRequest(raw, timestamp, signature, getSecret(), now.getTime());
  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { throw new AppError('Invalid CBU JSON body', 400); }
  const record = validateEnvelope(body, now);
  // Atomic monotonic upsert: a replayed/older but correctly signed snapshot
  // must never replace a newer official snapshot for this day.
  const affected = await prisma.$executeRaw`
    INSERT INTO "CbuRateInbox" ("day", "officialRows", "fetchedAt", "receivedAt")
    VALUES (${record.day}, CAST(${JSON.stringify(record.rates)} AS jsonb), ${record.fetchedAt}, ${now})
    ON CONFLICT ("day") DO UPDATE
      SET "officialRows" = EXCLUDED."officialRows",
          "fetchedAt" = EXCLUDED."fetchedAt",
          "receivedAt" = EXCLUDED."receivedAt"
    WHERE "CbuRateInbox"."fetchedAt" < EXCLUDED."fetchedAt"
  `;
  if (affected !== 1) throw new AppError('Older or duplicate CBU sync rejected', 409);
  return { accepted: true, date: record.day, currencies: CURRENCIES.size };
}

async function readFreshRates(day, { now = new Date(), prisma = require('../config/prisma') } = {}) {
  const record = await prisma.cbuRateInbox.findUnique({ where: { day } });
  if (!record || !(record.receivedAt instanceof Date) ||
      Math.abs(now.getTime() - record.receivedAt.getTime()) > FEED_MAX_AGE_MS) return null;
  try {
    const { _internals } = require('./cbuRates.service');
    return _internals.validateRates(record.officialRows, day);
  } catch { return null; }
}

// Testable HTTP handler: production uses the configured Prisma client,
// while staging/CI can supply an isolated database connection explicitly.
const createSyncHandler = ({ prisma, now = () => new Date() } = {}) => async (req, res) => {
  try {
    const options = { now: now() };
    if (prisma) options.prisma = prisma;
    const result = await acceptSignedEnvelope(req.body, req.headers, options);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false,
      message: error.statusCode ? error.message : 'CBU sync failed' });
  }
};
const handleSync = createSyncHandler();
module.exports = { verifySignedRequest, validateEnvelope, acceptSignedEnvelope,
  readFreshRates, createSyncHandler, handleSync };
