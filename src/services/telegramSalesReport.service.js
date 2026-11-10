// Telegram-only sales summary. Each cash movement is counted once in its own
// currency; foreign currency conversions use the saved order rate (UZS per
// major foreign unit). This never writes to the ledger or changes shift totals.
const { CURRENCIES, currencyFractionDigits } = require("../utils/money");
const { REVENUE_TYPES } = require("./cashAccounting.service");

const PAYMENT_BUCKETS = Object.freeze({
  CASH: "cashUzs",
  TERMINAL: "terminalUzs",
  CARD: "terminalUzs",
  TRANSFER: "terminalUzs",
  PAYME: "paymeUzs",
  CLICK: "clickUzs",
});
const FOREIGN_ORDER = ["USD", "RUB", "EUR", "TJS", "KZT"];

const readRate = (movement) => {
  const order = movement?.order;
  // Never apply a USD rate to a separate RUB cash movement, for example.
  if (!order || (order.currency && order.currency !== movement.currency)) return null;
  const source = order.exchangeRate ?? order.pricingSnapshot?.exchangeRate;
  if (source === null || source === undefined) return null;
  const text = String(source).trim();
  if (!/^\d+(?:\.\d{1,12})?$/.test(text) || Number(text) <= 0) return null;
  return text;
};

const convertForeignToUzs = (minor, currency, rate) => {
  if (!Number.isSafeInteger(minor)) return null;
  const digits = currencyFractionDigits[currency];
  if (!Number.isInteger(digits) || currency === "UZS" || !/^\d+(?:\.\d{1,12})?$/.test(String(rate))) return null;
  const [whole, fraction = ""] = String(rate).split(".");
  const scale = 10n ** BigInt(digits + fraction.length);
  const numerator = BigInt(whole + fraction);
  if (numerator <= 0n) return null;
  const signed = BigInt(minor);
  const abs = signed < 0n ? -signed : signed;
  const uzs = (abs * numerator + scale / 2n) / scale;
  if (uzs > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(signed < 0n ? -uzs : uzs);
};

const buildTelegramSalesSummary = (movements = []) => {
  const result = {
    totalUzs: 0,
    cashUzs: 0,
    terminalUzs: 0,
    clickUzs: 0,
    paymeUzs: 0,
    otherUzs: 0,
    foreign: [],
    hasUnknownRates: false,
    missingRates: [],
  };
  const byCurrency = new Map();
  const unknownByCurrency = new Map();
  const supportedRevenue = new Set(REVENUE_TYPES);
  for (const movement of movements) {
    if (!supportedRevenue.has(movement?.type) || !["IN", "OUT"].includes(movement.direction)) continue;
    const signed = (movement.direction === "OUT" ? -1 : 1) * Number(movement.amount || 0);
    if (!Number.isSafeInteger(signed)) continue;
    const currency = movement.currency || "UZS";
    if (currency === "UZS") {
      result.totalUzs += signed;
      const bucket = PAYMENT_BUCKETS[movement.paymentType] || "otherUzs";
      result[bucket] += signed;
      continue;
    }
    if (!CURRENCIES.includes(currency)) continue;
    const info = byCurrency.get(currency) || { currency, amountMinor: 0, uzs: 0, missingMinor: 0 };
    info.amountMinor += signed;
    const rate = readRate(movement);
    const converted = rate === null ? null : convertForeignToUzs(signed, currency, rate);
    if (converted === null) {
      info.missingMinor += signed;
      unknownByCurrency.set(currency, (unknownByCurrency.get(currency) || 0) + signed);
    } else {
      info.uzs += converted;
      result.totalUzs += converted;
    }
    byCurrency.set(currency, info);
  }
  result.foreign = [...byCurrency.values()]
    .filter((item) => item.amountMinor !== 0 || item.missingMinor !== 0)
    .sort((a, b) => FOREIGN_ORDER.indexOf(a.currency) - FOREIGN_ORDER.indexOf(b.currency));
  result.missingRates = [...unknownByCurrency.entries()]
    .filter(([, minor]) => minor !== 0)
    .map(([currency, amountMinor]) => ({ currency, amountMinor }));
  result.hasUnknownRates = result.missingRates.length > 0;
  return result;
};

module.exports = { buildTelegramSalesSummary, convertForeignToUzs, readRate };
