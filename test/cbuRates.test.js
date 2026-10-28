const test = require('node:test');
const assert = require('node:assert/strict');
const cbu = require('../src/services/cbuRates.service');

const mk = (Ccy, Nominal, Rate, Date = '28.10.2026') => ({ Ccy, Nominal, Rate, Date });
test('CBU reference rates handle Nominal, decimal comma, source and effective date', () => {
  const rub = cbu._internals.parseRate(mk('RUB', '1', '146,75'));
  assert.equal(rub.rate, 146.75);
  assert.equal(rub.effectiveDate, '2026-10-28');
  assert.equal(rub.source, 'CBU');
  assert.equal(cbu.toUzsEquivalent(100000, rub), 146750); // 1000.00 RUB
  const kzt = cbu._internals.parseRate(mk('KZT', 100, '2500.00'));
  assert.equal(kzt.rate, 25);
  assert.equal(cbu.toUzsEquivalent(100000, kzt), 25000); // 1000.00 KZT at 25 UZS
  const somoni = cbu._internals.parseRate(mk('TJS', 1, '1300.00'));
  assert.equal(cbu.toUzsEquivalent(1000, somoni), 13000); // 10.00 TJS
  assert.deepEqual(cbu.paymentSnapshot(100000, rub), {
    fxRate: '146.75', fxRateDate: '2026-10-28', fxNominal: 1, fxSource: 'CBU', uzsEquivalent: 146750,
  });
  const usd = cbu._internals.parseRate(mk('USD', 1, '12000.00'));
  assert.equal(cbu.toUzsEquivalent(2500, usd), 300000); // 25 USD
  const uzs = { currency: 'UZS', publishedRate: '1', nominal: 1 };
  assert.equal(cbu.toUzsEquivalent(345678, uzs), 345678);
});

test('CBU validation refuses missing rates or malformed publication', () => {
  const rows = ['USD','EUR','RUB','KZT','TJS'].map(code => mk(code,1,'123.45'));
  assert.equal(cbu._internals.validateRates(rows).RUB.rate, 123.45);
  assert.throws(() => cbu._internals.validateRates(rows.slice(1)), /USD/);
  assert.throws(() => cbu._internals.parseRate(mk('RUB', 0, '123.45')), /Invalid/);
  assert.throws(() => cbu._internals.parseRate(mk('RUB', 1, 'NaN')), /Invalid/);
  assert.throws(() => cbu.toUzsEquivalent(-100, cbu._internals.parseRate(mk('RUB',1,'100'))), /Invalid/);
});

test('CBU uses the Asia/Tashkent business date, not UTC date', () => {
  assert.equal(cbu.tashkentDate(new Date('2026-10-27T21:01:00Z')), '2026-10-28');
  assert.equal(cbu.tashkentDate(new Date('2026-10-28T18:59:59Z')), '2026-10-28');
});

test('CBU rates stale across multiple business days are never used for payments', () => {
  const rows = ['USD','EUR','RUB','KZT','TJS'].map(
    code => mk(code, 1, code === 'RUB' ? '145.96' : '12000', '22.10.2026')
  );
  assert.throws(() => cbu._internals.validateRates(rows, '2026-10-28'), /out of range/);
  const friday = rows.map(row => ({...row, Date:'23.10.2026'}));
  // Saturday, Sunday and first weekday after Friday can reuse the last rate,
  // but a second elapsed weekday without official publication is blocked.
  assert.equal(cbu._internals.validateRates(friday, '2026-10-26').RUB.rate, 145.96);
  assert.throws(() => cbu._internals.validateRates(friday, '2026-10-27'), /out of range/);
  assert.equal(cbu._internals.countElapsedWeekdays('2026-10-22','2026-10-28'), 2);
});

test('official CBU fallback accepts only correctly dated official feed, not stale currency rows', async (t) => {
  const priorFetch = global.fetch;
  const requested = '2026-08-17';
  const calls = [];
  const officialRows = ['USD','EUR','RUB','KZT','TJS']
    .map((code) => mk(code, 1, '120.00', '17.08.2026'));
  global.fetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/all/' + requested + '/')) return { ok: false, status: 404 };
    return { ok: true, json: async () => officialRows };
  };
  t.after(() => { global.fetch = priorFetch; });
  const rates = await cbu.getRates(new Date('2026-08-17T09:00:00Z'));
  assert.equal(rates.RUB.rate, 120);
  assert.deepEqual(calls, [
    'https://cbu.uz/uz/arkhiv-kursov-valyut/json/all/2026-08-17/',
    'https://cbu.uz/uz/arkhiv-kursov-valyut/json/',
  ]);
  const stale = ['USD','EUR','RUB','KZT','TJS'].map((code) => mk(code, 1, '120', '01.08.2026'));
  assert.throws(() => cbu._internals.validateRates(stale, requested), /out of range/);
  const future = ['USD','EUR','RUB','KZT','TJS'].map((code) => mk(code, 1, '120', '19.08.2026'));
  assert.throws(() => cbu._internals.validateRates(future, requested), /out of range/);
});
