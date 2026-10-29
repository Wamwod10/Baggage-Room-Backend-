const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const inbox = require('../src/services/googleFinanceInbox.service');

test('Google-only source is checked and does not accept stale/forged rates',async () => {
  const now = new Date('2026-10-29T09:00:00Z');
  const secret='test-google-only-0123456789-strong-secret';
  const prior=process.env.GOOGLE_FINANCE_SYNC_SECRET;
  process.env.GOOGLE_FINANCE_SYNC_SECRET=secret;
  try {
    const rates=['USD','EUR','RUB','KZT','TJS'].map(currency=>({
      currency,rate:currency==='RUB'?'149.0016':'12000.01'
    }));
    const payload={source:'GOOGLE_FINANCE',observedAt:now.toISOString(),rates};
    const raw=Buffer.from(JSON.stringify(payload));
    const timestamp=String(now.getTime());
    const signature='sha256='+crypto.createHmac('sha256',secret).update(timestamp).update('.').update(raw).digest('hex');
    const headers={'x-google-fx-timestamp':timestamp,'x-google-fx-signature':signature};
    let saved;
    const prisma={
      $executeRaw:async (_parts,...params)=>{
        saved={day:params[0],rates:JSON.parse(params[1]),observedAt:params[2],receivedAt:params[3]};
        return 1;
      },
      googleFinanceRateInbox:{findUnique:async()=>saved}
    };
    assert.deepEqual(await inbox.acceptSignedRates(raw,headers,{now,prisma}),{
      accepted:true,source:'GOOGLE_FINANCE',day:'2026-10-29',currencies:5
    });
    const fx=await inbox.getFreshRates('2026-10-29',{now,prisma});
    assert.equal(fx.RUB.rate,149.0016);
    assert.equal(fx.RUB.source,'GOOGLE_FINANCE');
    assert.equal(fx.RUB.effectiveDate,'2026-10-29');
    assert.equal(await inbox.getFreshRates('2026-10-29',{now:new Date(now.getTime()+70*60000),prisma}),null);
    assert.throws(()=>inbox.verifyHmac(Buffer.from(raw.toString().replace('149.0016','89')),headers,now),/signature/);
    assert.throws(()=>inbox.validatePayload({...payload,source:'CBU'},now),/Invalid Google Finance payload/);
    assert.throws(()=>inbox.validatePayload({...payload,rates:rates.slice(0,4)},now),/Invalid Google Finance payload/);
  } finally {
    if(prior===undefined)delete process.env.GOOGLE_FINANCE_SYNC_SECRET;
    else process.env.GOOGLE_FINANCE_SYNC_SECRET=prior;
  }
});
test('Google Sheets worker uses GOOGLEFINANCE, never a CBU endpoint',()=>{
  const js=fs.readFileSync(path.join(__dirname,'../scripts/googleFinanceRelay.gs'),'utf8');
  new vm.Script(js);
  assert.match(js,/GOOGLEFINANCE/);
  assert.doesNotMatch(js,/cbu\.uz|GOOGLEFINANCE\(.+TODAY\(/);
  assert.match(js,/X-Google-FX-Signature/);
});
