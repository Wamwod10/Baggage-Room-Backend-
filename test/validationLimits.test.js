const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { z } = require('zod');
const validate = require('../src/middleware/validate.middleware');

test('oversized order arrays are rejected before validation with bounded memory', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/orders', require('../src/routes/order.routes'));
  app.use('/shifts', require('../src/routes/shift.routes'));
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ message: err.message, errors: err.errors }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const pricing = require('../src/services/pricing.service');
  const originalQuote = pricing.quote;
  try {
    const url = `http://127.0.0.1:${server.address().port}/orders`;
    const payload = JSON.stringify({ items: Array.from({ length: 30000 }, () => ({ size: 'bad', count: 0 })) });
    assert.ok(Buffer.byteLength(payload) >= 750000 && Buffer.byteLength(payload) < 1000000);
    for (const [method, path, body] of [
      ['POST', '/quote', payload], ['POST', '', payload], ['PATCH', '/id', payload],
      ['POST', '', JSON.stringify({ lockerIds: Array(1001).fill('locker') })],
    ]) {
      const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body });
      assert.equal(response.status, 400);
      const text = await response.text();
      assert.ok(Buffer.byteLength(text) < 1024);
      assert.match(text, /1000/);
    }
    pricing.quote = async () => ({ total: 1 });
    const valid = await fetch(url + '/quote', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branchId: 'branch', hours: 1, currency: 'UZS', items: [{ size: 'S', count: 1 }] }) });
    assert.equal(valid.status, 200);
    const shift = await fetch(`http://127.0.0.1:${server.address().port}/shifts/open`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ openingCashByCurrency: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 } }) });
    assert.equal(shift.status, 400);
  } finally { pricing.quote = originalQuote; await new Promise((resolve) => server.close(resolve)); }
});

test('validation limits check array length before parsing and preserve normal requests', () => {
  let parsed = 0;
  const schema = { safeParse(input) { parsed++; return { success: true, data: input }; } };
  const middleware = validate(schema, { bodyArrayLimits: { items: 1000, lockerIds: 1000 } });
  const payload = JSON.stringify({ items: Array.from({ length: 30000 }, () => ({ size: 'bad', count: 0 })) });
  assert.ok(Buffer.byteLength(payload) >= 750000 && Buffer.byteLength(payload) < 1000000);
  const oversized = { body: JSON.parse(payload) };
  const before = process.memoryUsage().heapUsed;
  assert.throws(() => middleware(oversized, {}, () => {}), /1000/);
  assert.ok(process.memoryUsage().heapUsed - before < 8 * 1024 * 1024);
  assert.equal(parsed, 0);
  let nextCalled = false;
  middleware({ body: { items: Array(1000).fill(null), lockerIds: ['a'] } }, {}, () => { nextCalled = true; });
  assert.equal(parsed, 1);
  assert.equal(nextCalled, true);
});

test('validation errors are bounded in count and length', () => {
  const schema = z.object({ body: z.object({ values: z.array(z.string().min(2)) }) });
  const middleware = validate(schema);
  let error;
  try { middleware({ body: { values: Array(1000).fill('') } }, {}, () => {}); } catch (e) { error = e; }
  assert.equal(error.statusCode, 400);
  assert.ok(error.errors.length <= 20);
  assert.ok(Buffer.byteLength(JSON.stringify({ message: error.message, errors: error.errors })) <= 12000);
});

test('oversized currency maps are rejected before schema validation', () => {
  let parsed = false;
  const middleware = validate({ safeParse() { parsed = true; } }, { bodyObjectLimits: { openingCashByCurrency: 6 } });
  const map = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`invalid${i}`, 1]));
  assert.throws(() => middleware({ body: { openingCashByCurrency: map } }, {}, () => {}), /6/);
  assert.equal(parsed, false);
});
