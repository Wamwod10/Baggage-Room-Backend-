// Real PostgreSQL reconciliation. No application DB fallback is ever allowed.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { getJarvisData } = require('../src/integrations/jarvis/repository');
const { parseQuery } = require('../src/integrations/jarvis/query');
const express = require('express');
const { createJarvisRouter } = require('../src/integrations/jarvis/router');
const { assertResponse } = require('./jarvisContract');
const { summarizeMovements, cashBalanceByCurrency } = require('../src/services/cashAccounting.service');

test('Jarvis real PostgreSQL HTTP + ledger reconciliation (isolated DB required)', { skip: !process.env.JARVIS_TEST_DATABASE_URL ? 'JARVIS_TEST_DATABASE_URL not configured; financial SQL not verified against PostgreSQL' : false }, async t => {
  const url = new URL(process.env.JARVIS_TEST_DATABASE_URL);
  assert.match(url.pathname, /^\/jarvis_test(?:_|$)/, 'Only a disposable database named jarvis_test or jarvis_test_* is allowed');
  const identity = value => { const parsed = new URL(value); return parsed.hostname.replace('-pooler', '') + ':' + (parsed.port || '5432') + parsed.pathname; };
  for (const configured of [process.env.DATABASE_URL, process.env.DIRECT_URL].filter(Boolean)) assert.notEqual(identity(url.href), identity(configured), 'Refusing application DB');
  const schema = 'jarvis_test_' + crypto.randomBytes(10).toString('hex');
  const admin = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000 });
  let prisma, pool, server;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: url.href, options: `-c search_path=${schema}`, max: 3, connectionTimeoutMillis: 5000 });
    const migrationClient = await pool.connect();
    try {
      const root = path.join(__dirname, '../prisma/migrations');
      for (const directory of fs.readdirSync(root).sort()) {
        const filename = path.join(root, directory, 'migration.sql');
        if (!fs.existsSync(filename)) continue;
        const sql = fs.readFileSync(filename, 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', '');
        if (directory === '20261009120000_jarvis_financial_timestamps') {
          await migrationClient.query(`INSERT INTO "Branch" (id,name,code,"updatedAt") VALUES ('legacy','legacy','LEGACY',CURRENT_TIMESTAMP);
            INSERT INTO "User" (id,login,name,"passwordHash",role,"branchId","updatedAt") VALUES ('legacy','legacy','legacy','unused','BRANCH_ADMIN','legacy',CURRENT_TIMESTAMP);
            INSERT INTO "Shift" (id,"branchId","openedById","openedAt",status) VALUES ('legacy','legacy','legacy','2026-01-01T00:00:00Z','CLOSED')`);
        }
        await migrationClient.query(sql);
        if (directory === '20261009120000_jarvis_financial_timestamps') {
          await t.test('migration backfills historical shifts and installs four timestamp triggers', async () => {
            const { rows } = await migrationClient.query(`SELECT "createdAt"="openedAt" AS correct, "updatedAt" IS NOT NULL AS tracked FROM "Shift" WHERE id='legacy'`);
            assert.deepEqual(rows[0], { correct: true, tracked: true });
            const triggers = await migrationClient.query(`SELECT COUNT(*)::int AS count FROM information_schema.triggers WHERE trigger_schema=$1 AND trigger_name LIKE 'jarvis_%'`, [schema]);
            assert.equal(triggers.rows[0].count, 4);
          });
          await migrationClient.query(`DELETE FROM "Shift" WHERE id='legacy'; DELETE FROM "User" WHERE id='legacy'; DELETE FROM "Branch" WHERE id='legacy'`);
        }
      }
    } finally { migrationClient.release(); }
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }), log: [] });
    for (let n = 1; n <= 5; n++) await pool.query('INSERT INTO "Branch" (id,name,code,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,$4)', ['b' + n, 'Test branch ' + n, 'BR' + n, '2026-10-01T00:00:00Z']);
    await pool.query('INSERT INTO "User" (id,login,name,"passwordHash",role,"branchId","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7)', ['u1','test-staff','private staff','private-hash','BRANCH_ADMIN','b1','2026-10-01']);
    await pool.query(`INSERT INTO "Order" (id,"orderNumber","branchId","clientName",phone,passport,"tariffHours","paymentType","finalAmount","realPaidAmount","checkIn","plannedCheckOut","createdById","createdAt","updatedAt")
      VALUES ('o1','TEST-1','b1','private customer','private phone','private passport',1,'DEBT',999,0,'2026-10-08T19:00:00Z','2026-10-09T19:00:00Z','u1','2026-10-08T19:00:00Z','2026-10-08T19:00:00Z')`);
    await pool.query(`INSERT INTO "Shift" (id,"branchId","openedById","openingCash","acceptedCash","openingCashByCurrency","acceptedCashByCurrency","openedAt","createdAt","updatedAt",status)
      VALUES ('s0','b1','u1',1000,1000,'{"UZS":1000}','{"UZS":1000}','2026-10-07T19:00:00Z','2026-10-07T19:00:00Z','2026-10-07T19:00:00Z','CLOSED'),
      ('s1','b1','u1',100,20,'{"UZS":100}','{"UZS":20}','2026-10-08T19:00:00Z','2026-10-08T19:00:00Z','2026-10-08T19:00:00Z','OPEN')`);
    await pool.query(`UPDATE "Shift" SET status = 'CLOSED', "closedAt" = '2026-10-08T18:59:59Z' WHERE id = 's0'`);
    const movements = [
      ['pre', 'ORDER_PAYMENT','IN',77,'UZS','CASH','2026-10-08T18:59:59.999Z','s0'],
      ['base','ORDER_PAYMENT','IN',100,'UZS','CASH','2026-10-08T19:00:00Z','s1'],
      ['extra','ORDER_PAYMENT','IN',20,'UZS','CASH','2026-10-09T01:00:00Z','s1'],
      ['debt','DEBT_CLOSE','IN',30,'UZS','CASH','2026-10-09T02:00:00Z','s1'],
      ['refund','ORDER_PAYMENT','OUT',10,'UZS','CASH','2026-10-09T03:00:00Z','s1'],
      ['nominal','ORDER_PAYMENT','IN',999,'UZS','DEBT','2026-10-09T03:00:01Z','s1'],
      ['expense','EXPENSE','OUT',15,'UZS',null,'2026-10-09T04:00:00Z','s1'],
      ['inkassa','INKASSA','OUT',25,'UZS',null,'2026-10-09T05:00:00Z','s1'],
      ['manual','MANUAL_CORRECTION','IN',7,'UZS',null,'2026-10-09T06:00:00Z','s1'],
      ['card','ORDER_PAYMENT','IN',200,'UZS','CARD','2026-10-09T07:00:00Z','s1'],
      ['terminal','ORDER_PAYMENT','IN',80,'UZS','TERMINAL','2026-10-09T08:00:00Z','s1'],
      ['usd','ORDER_PAYMENT','IN',12,'USD','CASH','2026-10-09T09:00:00Z','s1'],
      ['click','ORDER_PAYMENT','IN',60,'UZS','CLICK','2026-10-09T10:00:00Z','s1'],
      ['payme','ORDER_PAYMENT','IN',70,'UZS','PAYME','2026-10-09T11:00:00Z','s1'],
      ['transfer','ORDER_PAYMENT','IN',90,'UZS','TRANSFER','2026-10-09T12:00:00Z','s1'],
      ['rub','ORDER_PAYMENT','IN',13,'RUB','CASH','2026-10-09T13:00:00Z','s1'],
      ['eur','ORDER_PAYMENT','IN',14,'EUR','CASH','2026-10-09T14:00:00Z','s1'],
      ['kzt','ORDER_PAYMENT','IN',15,'KZT','CASH','2026-10-09T15:00:00Z','s1'],
      ['tjs','ORDER_PAYMENT','IN',16,'TJS','CASH','2026-10-09T16:00:00Z','s1'],
      ['later','ORDER_PAYMENT','IN',40,'UZS','CASH','2026-10-09T19:00:00Z','s1'],
    ];
    for (const [id,type,direction,amount,currency,paymentType,createdAt,shiftId] of movements) await pool.query(`INSERT INTO "CashMovement" (id,"branchId","orderId","shiftId",type,direction,amount,currency,"paymentType","createdById","createdAt","updatedAt") VALUES ($1,'b1','o1',$2,$3,$4,$5,$6,$7,'u1',$8,$8)`, [id,shiftId,type,direction,amount,currency,paymentType,createdAt]);
    await pool.query(`INSERT INTO "Expense" (id,"branchId","shiftId",category,reason,amount,currency,"createdById","createdAt") VALUES ('e1','b1','s1','Oylik','private payee',15,'UZS','u1','2026-10-09T04:00:00Z')`);
    await pool.query(`INSERT INTO "Inkassa" (id,"branchId","shiftId","receiverName",amount,currency,"createdById","createdAt") VALUES ('i1','b1','s1','private receiver',25,'UZS','u1','2026-10-09T05:00:00Z')`);
    const get = (endpoint, query = {}) => getJarvisData(prisma, endpoint, parseQuery(query, endpoint));
    const period = { branchCode: 'BR1', from: '2026-10-09', to: '2026-10-09', currency: 'UZS', paymentType: 'CASH' };

    await t.test('reconciles revenue against independent raw ledger and excludes unpaid debt', async () => {
      const result = await get('sales', period);
      assert.equal(result.data[0].grossReceipts, '150');
      assert.equal(result.data[0].refunds, '10');
      assert.equal(result.data[0].netReceipts, '140');
      const raw = await pool.query(`SELECT SUM(CASE direction WHEN 'IN' THEN amount ELSE -amount END)::text AS total FROM "CashMovement" WHERE "branchId"='b1' AND type IN ('ORDER_PAYMENT','DEBT_CLOSE') AND "paymentType"='CASH' AND currency='UZS' AND "createdAt">='2026-10-08T19:00:00Z' AND "createdAt"<'2026-10-09T19:00:00Z'`);
      assert.equal(result.data[0].netReceipts, raw.rows[0].total);
      assert.equal((await get('sales', { ...period, paymentType: 'DEBT' })).data.length, 0);
      await pool.query(`UPDATE "Order" SET status='CANCELLED' WHERE id='o1'`);
      assert.equal((await get('sales', period)).data[0].netReceipts, '140', 'Cancellation status must not subtract refunds again');
    });
    await t.test('separates currencies/payment types and paginates after aggregation', async () => {
      const all = await get('sales', { from:'2026-10-09',to:'2026-10-09' });
      assert.equal(all.pagination.total, 11);
      const card = all.data.find(row => row.paymentType === 'CARD');
      assert.equal(card.netReceipts, '200');
      assert.equal(all.data.find(row => row.paymentType === 'TERMINAL').netReceipts, '80');
      assert.equal(all.data.find(row => row.currency === 'USD').netReceipts, '12');
      assert.equal(all.data.find(row => row.paymentType === 'CLICK').netReceipts, '60');
      assert.equal(all.data.find(row => row.paymentType === 'PAYME').netReceipts, '70');
      assert.equal(all.data.find(row => row.paymentType === 'TRANSFER').netReceipts, '90');
      for (const [currency, amount] of [['RUB','13'],['EUR','14'],['KZT','15'],['TJS','16']]) assert.equal(all.data.find(row => row.currency === currency).netReceipts, amount);
      const p1 = await get('sales', { from:'2026-10-09',to:'2026-10-09',page:'1',limit:'6' });
      const p2 = await get('sales', { from:'2026-10-09',to:'2026-10-09',page:'2',limit:'6' });
      assert.deepEqual([...p1.data,...p2.data],all.data);
      const beyond = await get('sales', { ...period,page:'999' });
      assert.equal(beyond.pagination.total, 1);
      assert.deepEqual(beyond.data, []);
      const empty = await get('sales', { branchCode:'missing' });
      assert.deepEqual(empty.data, []);
      assert.equal(empty.pagination.total, 0);
    });
    await t.test('matches existing cash accounting for real paid ledger and each currency', async () => {
      const { rows } = await pool.query(`SELECT * FROM "CashMovement" WHERE "createdAt">='2026-10-08T19:00:00Z' AND "createdAt"<'2026-10-09T19:00:00Z' AND "paymentType" IS DISTINCT FROM 'DEBT'`);
      const summary = summarizeMovements(rows);
      const sales = (await get('sales', { from:'2026-10-09',to:'2026-10-09' })).data;
      for (const currency of ['UZS','USD','RUB','EUR','KZT','TJS']) {
        const total = sales.filter(row=>row.currency===currency).reduce((sum,row)=>sum+BigInt(row.netReceipts),0n);
        assert.equal(String(total),String(summary.revenueByCurrency[currency]));
      }
      assert.equal(summary.terminalByCurrency.UZS,370); // CARD 200 + TERMINAL 80 + TRANSFER 90.
      assert.equal(summary.clickByCurrency.UZS,60);
      assert.equal(summary.paymeByCurrency.UZS,70);
      assert.equal(summary.inkassaByCurrency.UZS,25);
      const expected = cashBalanceByCurrency({ openingCashByCurrency:{UZS:100},acceptedCashByCurrency:{UZS:20},cashRevenueByCurrency:summary.cashByCurrency,expenseByCurrency:summary.expenseByCurrency,inkassaByCurrency:summary.inkassaByCurrency,manualInByCurrency:summary.manualInByCurrency,manualOutByCurrency:summary.manualOutByCurrency });
      const balances = (await get('cash-balances', { branchCode:'BR1',to:'2026-10-09' })).data;
      for (const row of balances) assert.equal(row.balance,String(expected[row.currency]));
    });
    await t.test('cash snapshot selects one latest baseline and exact Tashkent cutoff', async () => {
      const result = await get('cash-balances', { branchCode:'BR1',currency:'UZS',to:'2026-10-09' });
      assert.equal(result.data[0].shiftId, 's1');
      assert.equal(result.data[0].openingCash,'100');
      assert.equal(result.data[0].acceptedCash,'20');
      assert.equal(result.data[0].movementNet,'107');
      assert.equal(result.data[0].balance,'227');
      const raw = await pool.query(`SELECT SUM(CASE direction WHEN 'IN' THEN amount ELSE -amount END)::text AS total FROM "CashMovement" WHERE "branchId"='b1' AND currency='UZS' AND "createdAt">='2026-10-08T19:00:00Z' AND "createdAt"<'2026-10-09T19:00:00Z' AND ((type IN ('ORDER_PAYMENT','DEBT_CLOSE') AND "paymentType"='CASH') OR type IN ('EXPENSE','INKASSA','MANUAL_CORRECTION'))`);
      assert.equal(result.data[0].movementNet,raw.rows[0].total);
      assert.equal((await get('cash-balances', { branchCode:'BR1',currency:'UZS',to:'2026-10-09T02:00:00Z' })).data[0].balance,'270');
      assert.equal((await get('cash-balances', { branchCode:'BR2',currency:'UZS',to:'2026-10-09' })).data[0].balance,'0');
    });
    await t.test('mutable transactions keep IDs and advance updatedAt after raw DB edits', async () => {
      const before = (await get('transactions',period)).data.find(row=>row.id==='base');
      await pool.query(`UPDATE "CashMovement" SET amount=110 WHERE id='base'`);
      const after = (await get('transactions',period)).data.find(row=>row.id==='base');
      assert.equal(after.transactionId,before.transactionId);
      assert.ok(after.updatedAt>before.updatedAt);
      assert.equal((await get('sales',period)).data[0].netReceipts,'150');
    });
    await t.test('read-only repository transaction rejects business mutations', async () => {
      await assert.rejects(prisma.$transaction(async tx => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$executeRaw`UPDATE "CashMovement" SET amount = 1 WHERE id = 'base'`;
      }));
      assert.equal((await pool.query(`SELECT amount FROM "CashMovement" WHERE id='base'`)).rows[0].amount,110);
    });
    await t.test('all eight resources work over real HTTP without personal information', async () => {
      const key = crypto.randomBytes(32).toString('hex');
      const app = express();
      app.use('/api/integrations/jarvis/v1',createJarvisRouter({ client:prisma,config:{keys:[{id:'fixture',hash:crypto.createHash('sha256').update(key).digest('hex')}],rateLimit:100},auditSink:()=>{} }));
      server=app.listen(0,'127.0.0.1');
      await new Promise(resolve=>server.once('listening',resolve));
      const fingerprint = async () => {
        const result = {};
        for (const table of ['Branch','Order','CashMovement','Shift','Expense','Inkassa']) result[table] = (await pool.query(`SELECT COUNT(*)::int AS count,md5(string_agg(row_to_json(t)::text,'' ORDER BY id)) AS hash FROM "${table}" t`)).rows[0];
        return result;
      };
      const before = await fingerprint();
      for (const endpoint of ['branches','orders','transactions','sales','cash-balances','shifts','expenses','inkassa']) {
        const response=await fetch(`http://127.0.0.1:${server.address().port}/api/integrations/jarvis/v1/${endpoint}`,{headers:{'X-API-Key':key}});
        assert.equal(response.status,200,endpoint);
        const body=await response.json();
        assertResponse(endpoint,200,body);
        assert.ok(!JSON.stringify(body).includes('private'));
        assert.ok(body.data.every(row=>row.id&&row.branchCode&&row.createdAt&&row.updatedAt));
        if(endpoint==='branches') assert.equal(body.data.length,5);
        if(endpoint==='expenses') assert.equal(body.data[0].isSalary,true);
        for (const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS']) {
          const rejected = await fetch(`http://127.0.0.1:${server.address().port}/api/integrations/jarvis/v1/${endpoint}`,{method,headers:{'X-API-Key':key}});
          assert.equal(rejected.status,405,`${endpoint} ${method}`);
          assert.equal(rejected.headers.get('allow'),'GET');
        }
      }
      assert.deepEqual(await fingerprint(),before,'GETs and rejected methods must not change business DB records');
    });
    await t.test('two synthetic RUB and USD payments reconcile with Jarvis, old records remain unchanged', async () => {
      const { paymentSnapshot } = require('../src/services/cbuRates.service');
      const mockRate = (currency, rate) => ({
        currency, rate, publishedRate: String(rate), nominal: 1, source: 'CBU', effectiveDate: '2026-10-28',
      });
      const fixtures = [
        { id: 'fx-rub', order: 'FX-TEST-RUB', currency: 'RUB', amount: 10000, fx: mockRate('RUB', 146.75), expected: 14675 },
        { id: 'fx-usd', order: 'FX-TEST-USD', currency: 'USD', amount: 2500, fx: mockRate('USD', 12000), expected: 300000 },
      ];
      for (const entry of fixtures) {
        await pool.query(`INSERT INTO "Order" (id,"orderNumber","branchId","clientName",phone,"tariffHours","currency","paymentType","finalAmount","realPaidAmount","checkIn","plannedCheckOut","createdById","createdAt","updatedAt")
          VALUES ($1,$2,'b1','synthetic customer','synthetic-phone',1,$3,'CASH',$4,$4,'2026-10-28T06:00:00Z','2026-10-28T07:00:00Z','u1','2026-10-28T06:00:00Z','2026-10-28T06:00:00Z')`,
          [entry.id + '-order', entry.order, entry.currency, entry.amount]);
        const snap = paymentSnapshot(entry.amount, entry.fx);
        assert.equal(snap.uzsEquivalent, entry.expected);
        await pool.query(`INSERT INTO "CashMovement" (id,"branchId","orderId","shiftId",type,direction,amount,currency,"paymentType","createdById","createdAt","updatedAt","fxRate","fxRateDate","fxNominal","fxSource","uzsEquivalent")
          VALUES ($1,'b1',$2,'s1','ORDER_PAYMENT','IN',$3,$4,'CASH','u1','2026-10-28T06:00:00Z','2026-10-28T06:00:00Z',$5,$6,$7,$8,$9)`,
          [entry.id, entry.id + '-order', entry.amount, entry.currency, snap.fxRate, snap.fxRateDate, snap.fxNominal, snap.fxSource, snap.uzsEquivalent]);
      }
      const transactions = (await get('transactions', { branchCode: 'BR1', from: '2026-10-28', to: '2026-10-28' })).data;
      for (const entry of fixtures) {
        const row = transactions.find(item => item.id === entry.id);
        assert.ok(row, entry.id + ' missing from Jarvis');
        assert.equal(row.currency, entry.currency);
        assert.equal(row.amount, entry.amount);
        assert.equal(Number(row.fxRate), entry.fx.rate);
        assert.equal(row.fxRateDate, '2026-10-28');
        assert.equal(row.fxSource, 'CBU');
        assert.equal(row.uzsEquivalent, entry.expected);
      }
      const original = (await get('transactions', { branchCode: 'BR1', from: '2026-10-09', to: '2026-10-09' })).data.find(item=>item.id==='rub');
      assert.ok(original, 'existing RUB transaction must be retained');
      assert.equal(original.fxRate, null);
      assert.equal(original.uzsEquivalent, null);
    });
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve));
    if(prisma) await prisma.$disconnect();
    if(pool) await pool.end();
    // Only the random schema created above can be removed; never public or another DB.
    assert.match(schema,/^jarvis_test_[a-f0-9]{20}$/);
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
