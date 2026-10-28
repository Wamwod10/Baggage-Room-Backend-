// Diagnostic only. NEVER writes to the database or automatically enables a rate source.
// Requires a privately configured CURRENCYAPI_KEY, not a hardcoded/committed credential.
const { _internals, tashkentDate } = require('../src/services/cbuRates.service');

const CURRENCIES = ['RUB', 'USD', 'EUR', 'KZT', 'TJS'];
const BASE = 'https://api.currencyapi.com/v3/official';
const numberText = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('Missing or invalid rate value');
  }
  const asText = value.toString();
  if (!/^\\d+(?:\\.\\d{1,12})?$/.test(asText)) throw new Error('Unsupported rate precision');
  return asText;
};
const dateToCbu = (date) => {
  if (typeof date !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) {
    throw new Error('Missing publication date');
  }
  const [year, month, day] = date.split('-');
  return day + '.' + month + '.' + year;
};
const parseOfficialPair = (body, currency) => {
  if (!CURRENCIES.includes(currency) || !body || body.meta?.source !== 'cbu'
      || body.meta?.source_base_currency !== 'UZS'
      || body.meta?.base_currency !== currency) {
    throw new Error('Provider source or quotation direction does not match CBU');
  }
  const rate = numberText(body.data?.UZS?.value);
  if (body.data?.UZS?.code !== 'UZS') throw new Error('Missing UZS quotation');
  if (typeof body.meta.cross_rates !== 'boolean') throw new Error('Provider cross-rate disclosure missing');
  return {
    Ccy: currency, Nominal: '1', Rate: rate, Date: dateToCbu(body.meta.date),
    crossRates: body.meta.cross_rates,
  };
};
const verify = async ({ key = process.env.CURRENCYAPI_KEY, fetchImpl = fetch,
  day = tashkentDate(), timeoutMs = 7000 } = {}) => {
  if (!key) throw new Error('CURRENCYAPI_KEY must be set via secret manager');
  const pairs = await Promise.all(CURRENCIES.map(async code => {
    const url = new URL(BASE);
    url.searchParams.set('source', 'cbu');
    url.searchParams.set('base_currency', code);
    url.searchParams.set('currencies', 'UZS');
    const res = await fetchImpl(url.toString(), { headers: { apikey: key, Accept:'application/json' },
      signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error('CurrencyAPI HTTP ' + res.status);
    const body = await res.json();
    return parseOfficialPair(body, code);
  }));
  const effectiveDates = new Set(pairs.map(row=>row.Date));
  if (effectiveDates.size !== 1) throw new Error('Inconsistent CBU publication dates across currencies');
  _internals.validateRates(pairs, day); // rejects stale/invalid/future official dates
  return { valid: true, source: 'CBU (CurrencyAPI third-party relay)',
    verifiedFor: day, effectiveDate: pairs[0].Date,
    allPairsDerived: pairs.every(row => row.crossRates),
    rates: pairs.map(({Ccy,Rate,Nominal})=>({currency:Ccy,rate:Rate,nominal:Nominal})) };
};
if (require.main === module) {
  verify().then(result => console.log(JSON.stringify(result))).catch(err => {
    console.error(JSON.stringify({valid:false,error:err.message}));
    process.exitCode = 1;
  });
}
module.exports = { verify, parseOfficialPair };
