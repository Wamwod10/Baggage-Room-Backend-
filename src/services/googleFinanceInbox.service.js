const crypto = require('node:crypto');
const { AppError } = require('../utils/response');

const CURRENCIES = ['USD','EUR','RUB','KZT','TJS'];
const HMAC_WINDOW_MS = 5 * 60 * 1000;
const MAX_OBSERVATION_AGE_MS = 65 * 60 * 1000;
const MAX_RATE = 1000000000;
function timestampDay(date) {
  return require('./cbuRates.service').tashkentDate(date);
}
function verifyHmac(raw, headers, now = new Date(), secret = process.env.GOOGLE_FINANCE_SYNC_SECRET) {
  if (!secret || Buffer.byteLength(secret,'utf8') < 32) throw new AppError('Google Finance sync not configured',503);
  const timestamp = String(headers['x-google-fx-timestamp'] || '');
  const signature = String(headers['x-google-fx-signature'] || '').replace(/^sha256=/i,'').toLowerCase();
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > 32768) throw new AppError('Invalid Google Finance payload',400);
  if (!/^\d{13}$/.test(timestamp) || Math.abs(now.getTime()-Number(timestamp)) > HMAC_WINDOW_MS ||
      !/^[a-f0-9]{64}$/.test(signature)) throw new AppError('Invalid Google Finance signature',401);
  const expected = crypto.createHmac('sha256',secret).update(timestamp).update('.').update(raw).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(signature,'hex'), Buffer.from(expected,'hex'))) {
    throw new AppError('Invalid Google Finance signature',401);
  }
}
function validatePayload(payload, now = new Date()) {
  if (!payload || payload.source !== 'GOOGLE_FINANCE' || !Array.isArray(payload.rates)
      || payload.rates.length !== CURRENCIES.length) throw new AppError('Invalid Google Finance payload',400);
  const observedAt = new Date(payload.observedAt);
  if (!Number.isFinite(observedAt.getTime()) ||
      Math.abs(now.getTime()-observedAt.getTime()) > HMAC_WINDOW_MS) {
    throw new AppError('Google Finance observation time invalid',400);
  }
  const day = timestampDay(now);
  if (timestampDay(observedAt) !== day) throw new AppError('Google Finance observation day mismatch',400);
  const provided = new Map();
  for (const entry of payload.rates) {
    if (!entry || !CURRENCIES.includes(entry.currency) ||
        Object.keys(entry).some(k=>!['currency','rate'].includes(k)) ||
        provided.has(entry.currency)) throw new AppError('Google Finance currency set invalid',400);
    const rate = String(entry.rate);
    if (!/^\d+(?:\.\d{1,10})?$/.test(rate) || !Number.isFinite(Number(rate)) ||
        Number(rate) <= 0 || Number(rate) > MAX_RATE) throw new AppError('Google Finance rate invalid',400);
    provided.set(entry.currency,{ currency:entry.currency,rate });
  }
  if (provided.size !== CURRENCIES.length) throw new AppError('Google Finance currency missing',400);
  return {day,observedAt,rates:CURRENCIES.map(currency=>provided.get(currency))};
}
async function acceptSignedRates(raw, headers, { now = new Date(), prisma = require('../config/prisma') } = {}) {
  verifyHmac(raw,headers,now);
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); }
  catch { throw new AppError('Invalid Google Finance JSON',400); }
  const input = validatePayload(payload,now);
  const affected = await prisma.$executeRaw`
    INSERT INTO "GoogleFinanceRateInbox" ("day","rates","observedAt","receivedAt")
    VALUES (${input.day}, CAST(${JSON.stringify(input.rates)} AS jsonb), ${input.observedAt}, ${now})
    ON CONFLICT ("day") DO UPDATE
    SET "rates" = EXCLUDED."rates", "observedAt" = EXCLUDED."observedAt",
        "receivedAt" = EXCLUDED."receivedAt"
    WHERE "GoogleFinanceRateInbox"."observedAt" < EXCLUDED."observedAt"
  `;
  if (affected !== 1) throw new AppError('Duplicate or older Google Finance update',409);
  return {accepted:true,source:'GOOGLE_FINANCE',day:input.day,currencies:input.rates.length};
}
async function getFreshRates(day, { now = new Date(), prisma = require('../config/prisma') } = {}) {
  const entry = await prisma.googleFinanceRateInbox.findUnique({where:{day}});
  if (!entry || !entry.observedAt || !entry.receivedAt ||
      now.getTime() - new Date(entry.observedAt).getTime() > MAX_OBSERVATION_AGE_MS ||
      now.getTime() - new Date(entry.receivedAt).getTime() > MAX_OBSERVATION_AGE_MS) return null;
  try {
    const valid=validatePayload({source:'GOOGLE_FINANCE',observedAt:new Date(entry.observedAt).toISOString(),
      rates:entry.rates},new Date(entry.observedAt));
    if(valid.day!==day) return null;
    return Object.fromEntries(valid.rates.map(item=>[item.currency,{
      currency:item.currency,source:'GOOGLE_FINANCE',rate:Number(item.rate),
      publishedRate:item.rate,nominal:1,effectiveDate:day,
      observedAt:new Date(entry.observedAt).toISOString()
    }]));
  } catch {return null;}
}
const createHandler = ({prisma,now = ()=>new Date()} = {}) => async (req,res)=>{
  try {
    const opts={now:now()};
    if(prisma) opts.prisma=prisma;
    return res.status(200).json(await acceptSignedRates(req.body,req.headers,opts));
  } catch(error) {
    return res.status(error.statusCode||500).json({
      success:false,message:error.statusCode?error.message:'Google Finance sync failed'
    });
  }
};
module.exports={verifyHmac,validatePayload,acceptSignedRates,getFreshRates,createHandler,handleSync:createHandler()};
