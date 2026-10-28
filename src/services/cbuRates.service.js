const { AppError } = require('../utils/response');
const { currencyFractionDigits } = require('../utils/money');

// CBU official JSON reference rates. All rates are quoted in UZS per Nominal foreign units.
const CBU_URL = 'https://cbu.uz/uz/arkhiv-kursov-valyut/json/all/';
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
const validateRates = (body) => {
  if (!Array.isArray(body)) throw new Error('CBU rate response must be an array');
  const rates = Object.fromEntries(body.map(parseRate).filter(Boolean).map((fx) => [fx.currency, fx]));
  for (const currency of CURRENCIES) if (!rates[currency]) throw new Error('CBU rate missing for ' + currency);
  return rates;
};

const unavailable = () => new AppError(
  'Markaziy bank kurslarini hozir olish imkoni yo‘q. Noto‘g‘ri kursda xorijiy valyuta operatsiyasi yaratilmaydi; qayta urinib ko‘ring.', 503,
);

const getRates = async (now = new Date()) => {
  const day = tashkentDate(now);
  if (cached?.day === day && Date.now() - cached.fetchedAt < TTL_MS) return cached.rates;
  if (pending?.day === day) return pending.promise;
  const promise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(CBU_URL + day + '/', {
        signal: controller.signal, headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('CBU HTTP ' + response.status);
      const rates = validateRates(await response.json());
      // Never silently fall back to stale or manually configured rates.
      cached = { day, fetchedAt: Date.now(), rates };
      return rates;
    } catch {
      throw unavailable();
    } finally {
      clearTimeout(timeout);
    }
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
  _internals: { parseRate, validateRates, dateFromCbu } };
