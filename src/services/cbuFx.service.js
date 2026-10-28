// All FX prices are authoritative server snapshots of CBU's rate effective in Uzbekistan.
// The backend intentionally refuses foreign payments when the applicable day's rate is unavailable.
const { currencyFractionDigits } = require("../utils/money");

const CBU_SOURCE = "CBU";
const CBU_URL = "https://cbu.uz/uz/arkhiv-kursov-valyut/json/all/";
const tashkentDay = (date = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

const parseEffectiveDate = (value) => {
  const input = String(value || "").trim();
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(input);
  const iso = match ? `${match[3]}-${match[2]}-${match[1]}` : input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) {
    throw new Error("Invalid CBU effective date");
  }
  return iso;
};

const positiveRate = (value) => {
  const rate = String(value ?? "").trim();
  if (!/^\d+(\.\d{1,12})?$/.test(rate) || Number(rate) <= 0) throw new Error("Invalid CBU exchange rate");
  return rate;
};

const normalizeCbuRecord = (item, requestedDay) => {
  const code = String(item?.Ccy || "").toUpperCase();
  if (!Object.hasOwn(currencyFractionDigits, code) || code === "UZS") return null;
  const nominal = Number(item.Nominal);
  const raw = positiveRate(item.Rate);
  if (!Number.isSafeInteger(nominal) || nominal <= 0) throw new Error("Invalid CBU nominal");
  const effectiveDate = parseEffectiveDate(item.Date);
  if (effectiveDate > requestedDay) throw new Error("CBU effective date is in the future");
  const rate = (Number(raw) / nominal).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  positiveRate(rate);
  return { currency: code, rate, effectiveDate, source: CBU_SOURCE, nominal };
};

const createRateProvider = ({ fetchRates = async (day) => {
  const response = await fetch(`${CBU_URL}${day}/`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new Error(`CBU unavailable (HTTP ${response.status})`);
  return response.json();
}, now = () => new Date() } = {}) => {
  let cachedDay = null;
  let cachedRates = null;
  let pending = null;
  const getRates = async () => {
    const day = tashkentDay(now());
    if (day === cachedDay && cachedRates) return cachedRates;
    if (day === cachedDay && pending) return pending;
    cachedDay = day;
    cachedRates = null;
    pending = Promise.resolve().then(() => fetchRates(day)).then((rows) => {
      if (!Array.isArray(rows) || rows.length === 0) throw new Error("CBU returned no rates");
      const result = Object.fromEntries(rows.map((row) => normalizeCbuRecord(row, day))
        .filter(Boolean).map((row) => [row.currency, row]));
      if (!result.RUB || !result.USD || !result.EUR || !result.TJS || !result.KZT) {
        throw new Error("CBU response lacks a required currency");
      }
      cachedRates = result;
      return result;
    }).finally(() => { pending = null; });
    return pending;
  };
  const getRate = async (currency = "UZS") => {
    const code = String(currency || "UZS").toUpperCase();
    if (!Object.hasOwn(currencyFractionDigits, code)) throw new Error("Unsupported payment currency");
    if (code === "UZS") return { currency: "UZS", rate: "1", effectiveDate: tashkentDay(now()), source: "UZS" };
    const rates = await getRates();
    if (!rates[code]) throw new Error(`No CBU rate for ${code}`);
    return rates[code];
  };
  return { getRates, getRate };
};

const minorToUzs = (minorAmount, currency, rate) => {
  const digits = currencyFractionDigits[currency];
  if (digits === undefined) throw new TypeError("Unsupported currency");
  const value = BigInt(minorAmount);
  if (value < 0n) throw new TypeError("Amount must be nonnegative");
  const normalized = positiveRate(rate);
  const [whole, fraction = ""] = normalized.split(".");
  const multiplier = BigInt(whole + fraction);
  const divisor = (10n ** BigInt(digits + fraction.length));
  return ((value * multiplier * 2n + divisor) / (divisor * 2n)).toString();
};

const paymentFxFields = (minorAmount, currency, rateInfo) => {
  if (!rateInfo || rateInfo.currency !== currency) throw new TypeError("Trusted FX quote is required");
  return {
    fxRate: rateInfo.rate,
    fxRateDate: new Date(`${rateInfo.effectiveDate}T00:00:00.000Z`),
    uzsEquivalent: minorToUzs(minorAmount, currency, rateInfo.rate),
  };
};

const provider = createRateProvider();
module.exports = { getRates: provider.getRates, getRate: provider.getRate,
  minorToUzs, paymentFxFields, createRateProvider, tashkentDay, normalizeCbuRecord };
