const test = require('node:test');
const assert = require('node:assert/strict');
const { getJarvisData } = require('../src/integrations/jarvis/repository');
const { parseQuery } = require('../src/integrations/jarvis/query');

test('sales bounds DB concurrency without blocking other resources or losing queued requests', async () => {
  const pending = [];
  let active = 0, peak = 0;
  const client = { $transaction: async fn => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => pending.push(resolve));
    try { return await fn({ $executeRaw:async()=>{}, $queryRaw:async()=>[{total:0n}] }); }
    finally { active--; }
  } };
  const requests = Array.from({length:8}, () => getJarvisData(client,'sales',parseQuery({},'sales')));
  await new Promise(resolve => setImmediate(resolve));
  const started = pending.length;
  // Drain even if the assertion fails, leaving no outstanding transactions/timers.
  for (let batch=0; batch<8; batch++) {
    pending.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setImmediate(resolve));
  }
  const results = await Promise.all(requests);
  assert.equal(started,2);
  assert.equal(peak,2);
  assert.equal(results.length,8);
  assert.ok(results.every(result=>result.pagination.total===0 && result.data.length===0));
});

test('sales queue is bounded, times out before opening transactions, and leaves branches available', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const pending=[];
  let opened=0;
  const client={$transaction:async fn=>{
    opened++;
    if(opened<=2) await new Promise(resolve=>pending.push(resolve));
    return fn({$executeRaw:async()=>{},$queryRaw:async()=>[{total:0n}],branch:{count:async()=>0,findMany:async()=>[]}});
  }};
  const filters=parseQuery({},'sales');
  const active=[getJarvisData(client,'sales',filters),getJarvisData(client,'sales',filters)];
  await new Promise(resolve=>setImmediate(resolve));
  const waiting=Promise.allSettled(Array.from({length:16},()=>getJarvisData(client,'sales',filters)));
  await assert.rejects(getJarvisData(client,'sales',filters),/capacity/);
  assert.deepEqual((await getJarvisData(client,'branches',parseQuery({},'branches'))).data,[]);
  assert.equal(opened,3,'Waiting sales must not take pool connections');
  t.mock.timers.tick(5000);
  assert.ok((await waiting).every(result=>result.status==='rejected' && /queue timeout/.test(result.reason.message)));
  pending.forEach(resolve=>resolve());
  await Promise.all(active);
  assert.equal((await getJarvisData(client,'sales',filters)).pagination.total,0);
});

test('failed sales transaction releases capacity for subsequent requests', async () => {
  let attempts=0;
  const client={$transaction:async fn=>{
    if(++attempts<=2)throw new Error('DB failure');
    return fn({$executeRaw:async()=>{},$queryRaw:async()=>[{total:0n}]});
  }};
  const results=await Promise.allSettled(Array.from({length:8},()=>getJarvisData(client,'sales',parseQuery({},'sales'))));
  assert.equal(results.filter(result=>result.status==='rejected').length,2);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,6);
});
