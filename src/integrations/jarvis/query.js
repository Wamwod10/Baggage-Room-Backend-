const { parseDate } = require('../../utils/date');

const CURRENCIES = ['UZS', 'USD', 'RUB', 'EUR', 'KZT', 'TJS'];
const PAYMENT_TYPES = ['CASH', 'CARD', 'TERMINAL', 'CLICK', 'PAYME', 'TRANSFER', 'DEBT'];
const FILTERS = {
  branches: ['branchCode', 'from', 'to', 'page', 'limit'],
  orders: ['branchCode', 'from', 'to', 'currency', 'paymentType', 'page', 'limit'],
  transactions: ['branchCode', 'from', 'to', 'currency', 'paymentType', 'page', 'limit'],
  sales: ['branchCode', 'from', 'to', 'currency', 'paymentType', 'page', 'limit'],
  'cash-balances': ['branchCode', 'to', 'currency', 'page', 'limit'],
  shifts: ['branchCode', 'from', 'to', 'page', 'limit'],
  expenses: ['branchCode', 'from', 'to', 'currency', 'paymentType', 'page', 'limit'],
  inkassa: ['branchCode', 'from', 'to', 'currency', 'paymentType', 'page', 'limit'],
};

class JarvisError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const invalid = message => { throw new JarvisError(400, 'INVALID_FILTER', message); };

function date(value, name, boundary) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) invalid(`${name} must be an ISO date or timestamp with timezone`);
  // Validate the calendar portion independently: Date.parse normalizes Feb 30.
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== m - 1 || calendar.getUTCDate() !== d) invalid(`Invalid ${name}`);
  if (value.length > 10) {
    const [h, min, sec] = value.slice(11, 19).split(':').map(Number);
    if (h > 23 || min > 59 || sec > 59) invalid(`Invalid ${name}`);
    const offset = value.match(/([+-])(\d{2}):(\d{2})$/);
    if (offset && (Number(offset[2]) > 14 || Number(offset[3]) > 59 || (Number(offset[2]) === 14 && Number(offset[3]) !== 0))) invalid(`Invalid ${name}`);
  }
  try { return parseDate(value, name, boundary); } catch { return invalid(`Invalid ${name}`); }
}

function parseQuery(query, endpoint) {
  const allowed = FILTERS[endpoint] || [];
  for (const [name, value] of Object.entries(query)) {
    if (!allowed.includes(name)) invalid(`Unsupported filter: ${allowed.includes(name) ? name : 'unknown or incompatible'}`);
    if (typeof value !== 'string' || !value || value.length > 128) invalid('Filters must be nonempty single values');
  }
  const integer = (name, fallback, max) => {
    if (query[name] === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(query[name]) || !Number.isSafeInteger(Number(query[name])) || Number(query[name]) > max) invalid(`Invalid ${name}`);
    return Number(query[name]);
  };
  const page = integer('page', 1, 1000000);
  const limit = integer('limit', 50, 200);
  if (query.branchCode && !/^[A-Za-z0-9_-]{1,64}$/.test(query.branchCode)) invalid('Invalid branchCode');
  if (query.currency && !CURRENCIES.includes(query.currency)) invalid('Invalid currency');
  if (query.paymentType && !PAYMENT_TYPES.includes(query.paymentType)) invalid('Invalid paymentType');
  if (['expenses', 'inkassa'].includes(endpoint) && query.paymentType && query.paymentType !== 'CASH') invalid('This resource supports only CASH paymentType');
  const from = query.from ? date(query.from, 'from', 'start') : undefined;
  const to = query.to ? date(query.to, 'to', 'end') : undefined;
  if (from && to && from > to) invalid('from must not exceed to');
  return { branchCode: query.branchCode, currency: query.currency, paymentType: query.paymentType, from, to, page, limit, skip: (page - 1) * limit };
}

module.exports = { parseQuery, FILTERS, CURRENCIES, PAYMENT_TYPES, JarvisError };
