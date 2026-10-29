const { AppError } = require('../utils/response');
const { currencyFractionDigits } = require('../utils/money');

// CBU official JSON reference rates. All rates are quoted in UZS per Nominal foreign units.
const CBU_BASE = 'https://cbu.uz/uz/arkhiv-kursov-valyut/json/';
// Fail closed on delayed publications. Allow one elapsed weekday for
// weekends/time-zone publication lag; do not silently accept a multi-day-old
// third-party snapshot as today's CBU rate. Longer public holidays require a
// separately verified schedule rather than guessing.
const CBU_RATE_MAX_WEEKDAY_AGE = 1;
const countElapsedWeekdays = (fromDay, toDay) => {
  const from = Date.parse(fromDay + 'T00:00:00Z');
  const to = Date.parse(toDay + 'T00:00:00Z');
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return Infinity;
  let n = 0;
  for (let t = from + 86400000; t <= to; t += 86400000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) n++;
    if (n > CBU_RATE_MAX_WEEKDAY_AGE) return n;
  }
  return n;
};
const CURRENCIES = ['USD', 'EUR', 'RUB', 'KZT', 'TJS'];
const TTL_MS = 15 * 60 * 1000;
let cached = null;
let pending = null;

const tashkentDate = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
};

const decimal = (value) => String(value ?? '').trim().replace(/\s/g, '').replace(',', '.');
const validDecimal = (value) => /^\d+(?:\.\d{1,12})?$/.test(value) && Number(value) > 0;
const dateFromCbu = (value) => {
  const date = String(value || '');
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(date);
  if (!match) throw new Error('Invalid CBU effective date');
  return `${match[3]}-${match[2]}-${match[1]}`;
};
const parseRate = (record) => {
  const currency = String(record?.Ccy || '').toUpperCase();
  if (!CURRENCIES.includes(currency)) return null;
  const nominal = Number(record.Nominal);
  const publishedRate = decimal(record.Rate);
  if (!Number.isSafeInteger(nominal) || nominal <= 0 || !validDecimal(publishedRate)) {
    throw new Error('Invalid official CBU rate for ' + currency);
  }
  const rate = Number((Number(publishedRate) / nominal).toFixed(10));
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Invalid normalized CBU rate');
  return { currency, source: 'CBU', rate, publishedRate, nominal,
    effectiveDate: dateFromCbu(record.Date) };
};
const validateRates = (body, requestedDay = null) => {
  if (!Array.isArray(body)) throw new Error('CBU rate response must be an array');
  const rates = Object.fromEntries(body.map(parseRate).filter(Boolean).map((fx) => [fx.currency, fx]));
  for (const currency of CURRENCIES) {
    if (!rates[currency]) throw new Error('CBU rate missing for ' + currency);
    if (requestedDay) {
      const effective = Date.parse(rates[currency].effectiveDate + 'T00:00:00Z');
      const requested = Date.parse(requestedDay + 'T00:00:00Z');
      const elapsedWeekdays = countElapsedWeekdays(rates[currency].effectiveDate, requestedDay);
      // Saturday/Sunday can reuse Friday's official rate; unusually stale
      // weekday publications must never silently price current payments.
      if (!Number.isFinite(effective) || !Number.isFinite(requested) ||
          requested < effective || elapsedWeekdays > CBU_RATE_MAX_WEEKDAY_AGE) {
        throw new Error('CBU rate out of range for ' + currency);
      }
    }
  }
  return rates;
};

const unavailable = () => new AppError(
  'Markaziy bank kurslarini hozir olish imkoni yo‘q. Noto‘g‘ri kursda xorijiy valyuta operatsiyasi yaratilmaydi; qayta urinib ko‘ring.', 503,
);

const getRates = async (now = new Date()) => {
  const day = tashkentDate(now);
  // Explicit provider mode: never consult CBU or a browser rate when Google mode is active.
  if (process.env.FX_RATE_PROVIDER === 'GOOGLE_FINANCE') {
    const rates = await require('./googleFinanceInbox.service').getFreshRates(day,{now});
    if (!rates) throw new AppError(
      'Google Finance kurslari yangilanmagan. Xorijiy valyuta to‘lovi vaqtincha yopiq.',503);
    return rates;
  }
  if (cached?.day === day && Date.now() - cached.fetchedAt < TTL_MS) return cached.rates;
  if (pending?.day === day) return pending.promise;
  const promise = (async () => {
    // Optional authenticated domestic worker feed, stored in our own database.
    // Never fall back to stale browser config or untrusted third-party FX services.
    if (process.env.CBU_RELAY_ENABLED === '1') {
      try {
        const rates = await require('./cbuRateInbox.service').readFreshRates(day, { now });
        if (rates) {
          cached = { day, fetchedAt: Date.now(), rates };
          return rates;
        }
      } catch { /* Ignore missing/unavailable inbox; direct official feed is still attempted. */ }
    }
    // Only the Central Bank's OWN endpoints are trusted. The dated archive is
    // primary; the official current-rate feed is used for weekends/holidays.
    for (const url of [CBU_BASE + 'all/' + day + '/', CBU_BASE]) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);
      try {
        const response = await fetch(url, {
          signal: controller.signal, headers: { Accept: 'application/json' },
        });
        if (!response.ok) continue;
        const rates = validateRates(await response.json(), day);
        cached = { day, fetchedAt: Date.now(), rates };
        return rates;
      } catch {
        // Try the other official endpoint. Never use unverified third-party
        // exchange rates or obsolete browser-configured prices.
      } finally {
        clearTimeout(timeout);
      }
    }
    throw unavailable();
  })();
  pending = { day, promise };
  try { return await promise; }
  finally { if (pending?.promise === promise) pending = null; }
};

const getRate = async (currency = 'UZS', now = new Date()) => {
  const code = String(currency).toUpperCase();
  if (code === 'UZS') return { currency: 'UZS', source: 'UZS',
    rate: 1, publishedRate: '1', nominal: 1, effectiveDate: tashkentDate(now) };
  if (!CURRENCIES.includes(code)) throw new AppError('Unsupported currency: ' + code, 400);
  return (await getRates(now))[code];
};

// Convert native minor units to UZS via integer arithmetic. Honor CBU Nominal,
// e.g. a published 100-KZT rate must NOT be interpreted as the 1-KZT rate.
const toUzsEquivalent = (amountMinor, fx) => {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new TypeError('Invalid payment amount');
  const digits = currencyFractionDigits[fx.currency];
  if (digits === undefined) throw new TypeError('Invalid currency');
  const text = decimal(fx.publishedRate);
  if (!validDecimal(text)) throw new TypeError('Invalid rate');
  const [whole, fraction = ''] = text.split('.');
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(amountMinor) * BigInt(whole + fraction);
  const denominator = BigInt(fx.nominal) * scale * 10n ** BigInt(digits);
  const rounded = (numerator + denominator / 2n) / denominator;
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) throw new TypeError('UZS equivalent exceeds safe integer');
  return result;
};

const paymentSnapshot = (amountMinor, fx) => ({
  fxRate: String(fx.rate), fxRateDate: fx.effectiveDate, fxNominal: fx.nominal,
  fxSource: fx.source, uzsEquivalent: toUzsEquivalent(amountMinor, fx),
});
const quoteSnapshot = (amountMinor, fx) => ({
  currency: fx.currency, amountMinor, rate: fx.rate, publishedRate: fx.publishedRate,
  nominal: fx.nominal, effectiveDate: fx.effectiveDate, source: fx.source,
  uzsEquivalent: toUzsEquivalent(amountMinor, fx),
});

module.exports = { getRate, getRates, tashkentDate, paymentSnapshot, quoteSnapshot, toUzsEquivalent,
  _internals: { parseRate, validateRates, dateFromCbu, countElapsedWeekdays } };
