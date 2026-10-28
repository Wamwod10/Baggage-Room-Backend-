const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verify, parseOfficialPair } = require('../scripts/verifyCurrencyapiCbu');
const good = (code, date = '2026-10-28') => ({
  meta: {source:'cbu',source_base_currency:'UZS',base_currency:code,
    date,cross_rates:true},
  data: { UZS: { code:'UZS', value: code==='RUB'?145.96:code==='USD'?11965.51:1234.56 } },
});
test('CurrencyAPI diagnostic requires correct CBU publication, quote direction, date and key', async () => {
  const seen = [];
  const fetchImpl = async (url,options) => {
    const code = new URL(url).searchParams.get('base_currency');
    assert.equal(new URL(url).searchParams.get('source'), 'cbu');
    assert.equal(new URL(url).searchParams.get('currencies'), 'UZS');
    assert.equal(options.headers.apikey, 'test-placeholder-key');
    seen.push(code);
    return {ok:true,status:200,json:async()=>good(code)};
  };
  const result=await verify({key:'test-placeholder-key',day:'2026-10-28',fetchImpl});
  assert.equal(result.valid,true);
  assert.equal(result.rates.find(r=>r.currency==='RUB').rate,'145.96');
  assert.equal(result.source,'CBU (CurrencyAPI third-party relay)');
  assert.deepEqual(new Set(seen),new Set(['RUB','USD','EUR','KZT','TJS']));
});
test('CurrencyAPI diagnostic rejects outdated sources and wrong direction', async () => {
  assert.throws(()=>parseOfficialPair(good('RUB'),'USD'),/does not match/);
  const stale = async (url) => {
    const code = new URL(url).searchParams.get('base_currency');
    return {ok:true,status:200,json:async()=>good(code,'2026-10-22')};
  };
  await assert.rejects(verify({key:'test-placeholder-key',day:'2026-10-28',fetchImpl:stale}),/out of range/);
  await assert.rejects(verify({key:'',fetchImpl:stale}),/CURRENCYAPI_KEY/);
  assert.throws(()=>parseOfficialPair({...good('USD'),meta:{...good('USD').meta,source:'market'}},'USD'),/does not match/);
});
test('CurrencyAPI diagnostic rejects rate mismatches across five quotes', async () => {
  const inconsistent = async (url) => {
    const code=new URL(url).searchParams.get('base_currency');
    return {ok:true,status:200,json:async()=>good(code,code==='RUB'?'2026-10-27':'2026-10-28')};
  };
  await assert.rejects(verify({key:'test-placeholder-key',day:'2026-10-28',fetchImpl:inconsistent}),/Inconsistent/);
});
