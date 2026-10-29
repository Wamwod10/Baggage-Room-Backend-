const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/googleCbuRelay.gs'), 'utf8');
const day = '2026-10-29';
const rows = ['USD','EUR','RUB','KZT','TJS'].map(Ccy => ({
  Ccy, Rate: Ccy === 'RUB' ? '145.96' : '12000', Nominal: 1, Date: '29.10.2026'
}));

const make = ({ cbu = rows, secret = 'staging-only-strong-key-0123456789abcdef', responseCode = 200 } = {}) => {
  const requests = [];
  const triggers = [];
  let lockReleased = false;
  const target = 'https://staging.example.org/api/integrations/cbu-rate-sync';
  const ctx = {
    console: { log() {} }, Date, Number, String, JSON, Array, Object, Error,
    Utilities: {
      Charset: {UTF_8: 'UTF-8'},
      formatDate() { return day; },
      newBlob(s) { return {getBytes: () => [...Buffer.from(s,'utf8')]}; },
      computeHmacSha256Signature(msg, key) {
        return [...crypto.createHmac('sha256',key).update(msg).digest()].map(x=>x>=128?x-256:x);
      }
    },
    PropertiesService: {getScriptProperties:()=>({getProperty:(key)=>({
      CBU_SYNC_SHARED_SECRET:secret, CBU_SYNC_TARGET_URL:target
    })[key]})},
    UrlFetchApp: { fetch:(url, options)=>{
      requests.push({url,options});
      if (url.startsWith('https://cbu.uz/')) {
        return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(cbu)};
      }
      return {getResponseCode:()=>responseCode,getContentText:()=>
        JSON.stringify({accepted:true,date:day,currencies:5})};
    }},
    LockService: {getScriptLock:()=>({
      tryLock:()=>true,releaseLock:()=>{lockReleased=true}
    })},
    ScriptApp:{
      getProjectTriggers:()=>triggers,
      deleteTrigger:(x)=>{const i=triggers.indexOf(x);if(i>=0)triggers.splice(i,1);},
      newTrigger:()=>({
        timeBased:()=>({everyMinutes:(min)=>({
          create:()=>triggers.push({getHandlerFunction:()=> 'syncGoogleCbuRates',min})
        })})
      })
    }
  };
  vm.runInNewContext(source, ctx, {filename:'googleCbuRelay.gs'});
  return {ctx,requests,triggers,target,wasReleased:()=>lockReleased};
};

test('Google Apps Script uses actual CBU JSON and signs exact backend payload', () => {
  const {ctx,requests,target,wasReleased}=make();
  assert.equal(ctx.probeCbu().currencies,5);
  assert.equal(requests.length,1);
  ctx.syncGoogleCbuRates();
  assert.equal(wasReleased(),true);
  const outbound=requests.find(x=>x.url===target);
  assert.ok(outbound);
  assert.equal(outbound.options.method,'post');
  const sent=JSON.parse(outbound.options.payload);
  assert.equal(sent.source,'CBU');
  assert.equal(sent.rates.find(x=>x.Ccy==='RUB').Rate,'145.96');
  assert.equal(sent.rates.length,5);
  const ts=outbound.options.headers['X-CBU-Sync-Timestamp'];
  const signature=crypto.createHmac('sha256','staging-only-strong-key-0123456789abcdef')
    .update(ts+'.'+outbound.options.payload).digest('hex');
  assert.equal(outbound.options.headers['X-CBU-Sync-Signature'],'sha256='+signature);
});

test('Google relay refuses stale or missing official CBU and makes no backend writes', () => {
  for (const bad of [
    rows.map(x=>({...x,Date:'22.10.2026'})),
    rows.filter(x=>x.Ccy!=='TJS'),
    rows.map(x=>({...x,Rate:'89-unknown'})),
  ]) {
    const {ctx,requests}=make({cbu:bad});
    assert.throws(()=>ctx.syncGoogleCbuRates(),/No fresh official CBU feed/);
    assert.equal(requests.filter(x=>!x.url.startsWith('https://cbu.uz/')).length,0);
  }
});

test('Google relay refuses absent secret and backend failure, releases lock', () => {
  const secretMissing=make({secret:''});
  assert.throws(()=>secretMissing.ctx.syncGoogleCbuRates(),/not configured/);
  assert.equal(secretMissing.requests.length,0);
  assert.equal(secretMissing.wasReleased(),true);
  const badAck=make({responseCode:503});
  assert.throws(()=>badAck.ctx.syncGoogleCbuRates(),/Backend rejected/);
  assert.equal(badAck.wasReleased(),true);
});

test('Google Apps Script trigger installer is idempotent and supports stopping',()=>{
  const {ctx,triggers}=make();
  assert.equal(ctx.installCbuTrigger().installed,true);
  assert.equal(triggers.length,1);
  assert.equal(triggers[0].min,30);
  assert.equal(ctx.installCbuTrigger().installed,false);
  assert.equal(triggers.length,1);
  ctx.stopCbuTrigger();
  assert.equal(triggers.length,0);
});
