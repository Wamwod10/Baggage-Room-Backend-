const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const relay = require('../src/services/cbuRateInbox.service');

const NOW = new Date('2026-10-28T11:00:00Z');
const SECRET = 'test-only-private-secret-with-more-than-32-characters';
const rows = ['RUB','USD','EUR','TJS','KZT'].map(Ccy => ({
  Ccy, Nominal: Ccy === 'KZT' ? '100' : '1',
  Rate: Ccy === 'RUB' ? '146.75' : Ccy === 'USD' ? '12000.00' : '1234.56',
  Date: '28.10.2026',
}));
function signed(payload, at = NOW.getTime(), secret = SECRET) {
  const raw = Buffer.from(JSON.stringify(payload));
  const timestamp = String(at);
  const signature = 'sha256=' + crypto.createHmac('sha256',secret).update(timestamp).update('.').update(raw).digest('hex');
  return {raw,headers:{'x-cbu-sync-timestamp':timestamp,'x-cbu-sync-signature':signature}};
}

test('signed CBU sync stores 5 official values in isolated fake store and reads exact date', async (t) => {
  const previous = process.env.CBU_SYNC_SHARED_SECRET;
  process.env.CBU_SYNC_SHARED_SECRET = SECRET;
  t.after(()=>{ if(previous===undefined)delete process.env.CBU_SYNC_SHARED_SECRET;else process.env.CBU_SYNC_SHARED_SECRET=previous;});
  let record;
  const prisma = { cbuRateInbox:{
    upsert:async query => { record={...query.create};return record; },
    findUnique:async()=>record,
  }};
  const payload={source:'CBU', fetchedAt:NOW.toISOString(), rates:rows};
  const {raw,headers}=signed(payload);
  const result=await relay.acceptSignedEnvelope(raw,headers,{prisma,now:NOW});
  assert.deepEqual(result,{accepted:true,date:'2026-10-28',currencies:5});
  const actual=await relay.readFreshRates('2026-10-28',{prisma,now:NOW});
  assert.equal(actual.RUB.rate,146.75);
  assert.equal(actual.USD.rate,12000);
  assert.equal(actual.KZT.rate,12.3456);
  assert.equal(actual.RUB.source,'CBU');
  assert.equal(await relay.readFreshRates('2026-10-28',{prisma,now:new Date('2026-10-30T14:00:00Z')}),null);
});

test('HMAC rejects forged, replayed, missing or short-secret messages',() => {
  const {raw,headers}=signed({source:'CBU',fetchedAt:NOW.toISOString(),rates:rows});
  assert.equal(relay.verifySignedRequest(raw,headers['x-cbu-sync-timestamp'],headers['x-cbu-sync-signature'],SECRET,NOW.getTime()),true);
  assert.throws(()=>relay.verifySignedRequest(Buffer.from('changed'),headers['x-cbu-sync-timestamp'],headers['x-cbu-sync-signature'],SECRET,NOW.getTime()),/authentication/);
  assert.throws(()=>relay.verifySignedRequest(raw,headers['x-cbu-sync-timestamp'],headers['x-cbu-sync-signature'],SECRET,NOW.getTime()+600000),/authentication/);
  assert.throws(()=>relay.verifySignedRequest(raw,headers['x-cbu-sync-timestamp'],headers['x-cbu-sync-signature'],'weak',NOW.getTime()),/not configured/);
});

test('relay rejects missing currencies and future publication dates',() => {
  const base={source:'CBU',fetchedAt:NOW.toISOString(),rates:rows};
  assert.equal(relay.validateEnvelope(base,NOW).rates.length,5);
  assert.throws(()=>relay.validateEnvelope({...base,rates:rows.slice(1)},NOW),/Invalid CBU sync payload|incomplete/);
  assert.throws(()=>relay.validateEnvelope({...base,rates:[...rows.slice(0,4),{...rows[4],Date:'29.10.2026'}]},NOW),/Invalid official/);
  assert.throws(()=>relay.validateEnvelope({...base,fetchedAt:'2026-10-27T00:00:00Z'},NOW),/timestamp is stale/);
  assert.throws(()=>relay.validateEnvelope({...base,rates:[...rows.slice(0,4),{...rows[4],Ccy:'XYZ'}]},NOW),/unsupported/);
});
