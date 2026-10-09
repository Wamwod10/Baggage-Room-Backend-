const path = require('node:path');
const { createRequire } = require('node:module');
const requireBackend = createRequire(path.resolve(__dirname, '../package.json'));
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Pool } = requireBackend('pg');
const url = process.env.JARVIS_TEST_DATABASE_URL;
assert.ok(url, 'Explicit disposable test URL required');
const target = new URL(url);
assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname), 'Local test PostgreSQL only');
assert.match(target.pathname, /^\/jarvis_test(?:_|$)/);
assert.equal(target.searchParams.get('sslmode'), 'disable', 'Disposable local non-TLS PostgreSQL only');
Object.assign(process.env, {DATABASE_URL:url,DIRECT_URL:url,NODE_ENV:'production',GOOGLE_SHEETS_ENABLED:'false',GOOGLE_SHEET_WEBHOOK:'',GOOGLE_SHEETS_WEBHOOK:'',OVERDUE_JOB_ENABLED:'false',JWT_SECRET:crypto.randomBytes(32).toString('hex'),JARVIS_RATE_LIMIT_MAX:'10000'});
const key = crypto.randomBytes(32).toString('hex');
process.env.JARVIS_API_KEYS=JSON.stringify([{id:'local',hash:crypto.createHash('sha256').update(key).digest('hex')}]);
const pool=new Pool({connectionString:url,max:2});
const results={label:'after',plans:[],runs:[]};
let server,prisma;
const realFetch=global.fetch;
async function main(){
  assert.ok((await pool.query('SELECT COUNT(*)::int n FROM "CashMovement"')).rows[0].n>=1000000, 'At least one million ledger rows required');
  results.settings=(await pool.query("SELECT name,setting FROM pg_settings WHERE name IN ('work_mem','max_connections','max_parallel_workers_per_gather','statement_timeout')")).rows;
  results.indexes=(await pool.query("SELECT indexdef FROM pg_indexes WHERE tablename='CashMovement'")).rows;
  const {getJarvisData}=requireBackend(path.resolve(__dirname, '../src/integrations/jarvis/repository.js'));
  const {parseQuery}=requireBackend(path.resolve(__dirname, '../src/integrations/jarvis/query.js'));
  const queries=[];
  await getJarvisData({$transaction:fn=>fn({$executeRaw:async()=>{},$queryRaw:async q=>{queries.push(q);return [{total:0n}];}})},'sales',parseQuery({},'sales'));
  for(const q of queries){
    const plan=(await pool.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+q.text,q.values)).rows[0]['QUERY PLAN'][0];
    results.plans.push({executionMs:plan['Execution Time'],tempReadBlocks:plan.Plan['Temp Read Blocks'],tempWrittenBlocks:plan.Plan['Temp Written Blocks']});
  }
  const app=requireBackend(path.resolve(__dirname, '../src/app.js'));
  prisma=requireBackend(path.resolve(__dirname, '../src/config/prisma.js'));
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const origin=`http://127.0.0.1:${server.address().port}/api/integrations/jarvis/v1/sales`;
  global.fetch=(address,options)=>{assert.ok(String(address).startsWith(origin),'External delivery prohibited');return realFetch(address,options);};
  const request=async suffix=>{const start=performance.now();const r=await fetch(origin+(suffix||''),{headers:{'X-API-Key':key},signal:AbortSignal.timeout(15000)});return {status:r.status,ms:Math.round(performance.now()-start),body:await r.json()};};
  for(const concurrency of [1,2,8]){
    const samples=[],load=[];let sampling=true;
    const sampler=(async()=>{while(sampling){load.push((await pool.query("SELECT COUNT(*) FILTER (WHERE state='active' AND pid<>pg_backend_pid())::int active,COUNT(*) FILTER (WHERE wait_event_type='Lock')::int locks,COUNT(*) FILTER (WHERE wait_event_type='IO')::int io FROM pg_stat_activity WHERE datname=current_database()")).rows[0]);await new Promise(r=>setTimeout(r,200));}})();
    const batches=Math.ceil(24/concurrency);
    try { for(let n=0;n<batches;n++)samples.push(...await Promise.all(Array.from({length:concurrency},()=>request()))); }
    finally { sampling=false;await sampler; }
    const times=samples.map(x=>x.ms).sort((a,b)=>a-b);
    const run={concurrency,n:samples.length,p95Ms:times[Math.ceil(times.length*.95)-1],minMs:times[0],maxMs:times.at(-1),statuses:samples.map(x=>x.status),maxActive:Math.max(...load.map(x=>x.active)),lockSamples:load.filter(x=>x.locks).length,ioSamples:load.filter(x=>x.io).length};
    results.runs.push(run);console.log('BENCHMARK',JSON.stringify(run));
    assert.ok(samples.every(x=>x.status===200),'All-time parallel sales must not time out');
  }
  if(results.label!=='before'){
    const all=[];let total;
    for(let page=1;;page++){const r=await request(`?limit=200&page=${page}`);assert.equal(r.status,200);total=r.body.pagination.total;all.push(...r.body.data);if(page>=r.body.pagination.totalPages)break;}
    assert.equal(all.length,total);assert.equal(new Set(all.map(x=>x.id)).size,total);
    const expected=(await pool.query(`SELECT b.code AS "branchCode",to_char((m."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tashkent')::date,'YYYY-MM-DD') AS day,m.currency::text AS currency,m."paymentType"::text AS "paymentType",SUM(m.amount) FILTER(WHERE direction='IN') AS gross,SUM(m.amount) FILTER(WHERE direction='OUT') AS refund,SUM(CASE direction WHEN 'IN' THEN amount ELSE -amount END)::text AS net,COUNT(*)::int AS count FROM "CashMovement" m JOIN "Branch" b ON b.id=m."branchId" WHERE type IN ('ORDER_PAYMENT','DEBT_CLOSE') AND "paymentType" IS NOT NULL AND "paymentType"<>'DEBT' GROUP BY b.code,day,m.currency,m."paymentType" ORDER BY day,b.code,currency,"paymentType"`)).rows;
    assert.deepEqual(all.map(x=>[x.branchCode,x.day,x.currency,x.paymentType,x.grossReceipts,x.refunds,x.netReceipts,x.transactionCount]),expected.map(x=>[x.branchCode,x.day,x.currency,x.paymentType,String(x.gross||0),String(x.refund||0),x.net,x.count]));
    results.reconciliation={groups:total,allPagesExact:true};
    for(const suffix of ['?page=999999','?branchCode=missing','?paymentType=DEBT']){const r=await request(suffix);assert.equal(r.status,200);assert.equal(r.body.data.length,0);if(suffix.includes('page='))assert.equal(r.body.pagination.total,total);}
  }
}
main().catch(e=>{results.error=e.message;console.error(e);process.exitCode=1;}).finally(async()=>{global.fetch=realFetch;console.log('SALES LOAD RESULTS',JSON.stringify(results));if(server)await new Promise(r=>server.close(r));if(prisma)await prisma.$disconnect();await pool.end();});
