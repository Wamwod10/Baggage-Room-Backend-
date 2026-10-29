// Run this from an Uzbekistan-based machine/VPS with official CBU access.
// No application database credentials are needed. Never store secrets in code.
const crypto = require('node:crypto');
const { _internals, tashkentDate } = require('../src/services/cbuRates.service');

const VALID_CURRENCIES = new Set(['USD','EUR','RUB','KZT','TJS']);
async function run() {
  const secret = process.env.CBU_SYNC_SHARED_SECRET;
  const target = process.env.CBU_SYNC_TARGET_URL;
  if (!secret || Buffer.byteLength(secret) < 32 || !target) throw new Error('CBU relay configuration missing');
  const dest = new URL(target);
  if (dest.protocol !== 'https:' || dest.pathname !== '/api/integrations/cbu-rate-sync') {
    throw new Error('CBU sync endpoint must use the dedicated HTTPS path');
  }
  const day = tashkentDate();
  let rows = null;
  for (const source of [
    'https://cbu.uz/uz/arkhiv-kursov-valyut/json/all/' + day + '/',
    'https://cbu.uz/uz/arkhiv-kursov-valyut/json/',
  ]) {
    try {
      const response = await fetch(source, { signal: AbortSignal.timeout(9000), headers: {Accept:'application/json'} });
      if (!response.ok) continue;
      const data = await response.json();
      _internals.validateRates(data, day);
      rows = data;
      break;
    } catch { /* Only the next official CBU endpoint is allowed. */ }
  }
  if (!rows) throw new Error('No validated official CBU feed; no update sent');
  const rates = rows.filter(row => VALID_CURRENCIES.has(row.Ccy))
    .map(row => ({ Ccy: row.Ccy, Rate: row.Rate, Nominal: row.Nominal, Date: row.Date }));
  _internals.validateRates(rates, day);
  const raw = JSON.stringify({ source: 'CBU', fetchedAt: new Date().toISOString(), rates });
  const time = String(Date.now());
  const signature = crypto.createHmac('sha256', secret).update(time).update('.').update(raw).digest('hex');
  const response = await fetch(target, { method:'POST', signal:AbortSignal.timeout(10000), headers:{
    'Content-Type':'application/json', 'X-CBU-Sync-Timestamp':time, 'X-CBU-Sync-Signature':'sha256='+signature,
  }, body:raw });
  if (!response.ok) throw new Error('CBU sync rejected (' + response.status + ')');
  console.log(JSON.stringify({ event:'CBU_SYNC_OK', day, currencyCount:rates.length }));
}
if (require.main === module) run().catch(error => {
  console.error('CBU_SYNC_FAILED:', error.message);
  process.exitCode = 1;
});
module.exports = { run };
