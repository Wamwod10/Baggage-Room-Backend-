const sum = (items, selector = (item) => item.amount) =>
  items.reduce((total, item) => total + Number(selector(item) || 0), 0);

const byKeySum = (items, key, selector = (item) => item.amount) =>
  items.reduce((acc, item) => {
    const group = item[key] || "UNKNOWN";
    acc[group] = (acc[group] || 0) + Number(selector(item) || 0);
    return acc;
  }, {});

const currencyFractionDigits = {
  UZS: 0,
  USD: 2,
  EUR: 2,
  RUB: 2,
  KZT: 2,
  TJS: 2,
};

const CURRENCIES = Object.freeze(Object.keys(currencyFractionDigits));

const normalizeCurrencyAmount = (amount, currency = "UZS") => {
  const code = String(currency || "UZS").toUpperCase();
  const digits = currencyFractionDigits[code];
  if (digits === undefined) throw new TypeError(`Unsupported currency: ${code}`);

  const minorAmount = Number(amount);
  if (!Number.isFinite(minorAmount)) throw new TypeError("Invalid currency amount");
  return minorAmount / 10 ** digits;
};

const byCurrency = (items, selector = (item) => item.amount) =>
  CURRENCIES.reduce((result, currency) => {
    result[currency] = sum(
      (Array.isArray(items) ? items : []).filter((item) => item?.currency === currency),
      selector,
    );
    return result;
  }, {});

const subtractCurrencyMaps = (base = {}, ...subtractors) =>
  CURRENCIES.reduce((result, currency) => {
    result[currency] = Number(base[currency] || 0) - subtractors.reduce(
      (total, map) => total + Number(map?.[currency] || 0),
      0,
    );
    return result;
  }, {});

const convertUzsToCurrencyMinor = (amountUZS, currency = "UZS", exchangeRate = 1) => {
  const code = currency || "UZS";
  if (code === "UZS") return Math.round(Number(amountUZS || 0));

  const rate = Number(exchangeRate || 0);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new TypeError(`Exchange rate for ${code} is required`);
  }

  const digits = currencyFractionDigits[code] ?? 2;
  return Math.round((Number(amountUZS || 0) / rate) * 10 ** digits);
};

const parseCurrency = (value, currency = "UZS") => {
  if (Number.isInteger(value)) return value;
  const digits = currencyFractionDigits[currency] ?? 2;
  const raw = String(value ?? "0").trim().replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new TypeError("Invalid currency amount");
  }

  const negative = raw.startsWith("-");
  const normalized = negative ? raw.slice(1) : raw;
  const [major, fraction = ""] = normalized.split(".");
  if (fraction.length > digits) {
    throw new TypeError(`Currency ${currency} supports ${digits} fraction digits`);
  }
  const minor = `${fraction}${"0".repeat(digits)}`.slice(0, digits);
  const amount = Number(major) * 10 ** digits + Number(minor || 0);
  return negative ? -amount : amount;
};

const formatCurrency = (amount, currency = "UZS", locale = "uz-UZ") => {
  const digits = currencyFractionDigits[currency] ?? 2;
  const major = Number(amount || 0) / 10 ** digits;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(major);
};

module.exports = {
  CURRENCIES,
  sum,
  byKeySum,
  byCurrency,
  subtractCurrencyMaps,
  parseCurrency,
  formatCurrency,
  normalizeCurrencyAmount,
  currencyFractionDigits,
  convertUzsToCurrencyMinor,
};
