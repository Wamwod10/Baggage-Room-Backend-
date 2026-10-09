const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { createJarvisRouter } = require('../src/integrations/jarvis/router');
const { FILTERS } = require('../src/integrations/jarvis/query');
const { assertResponse } = require('./jarvisContract');
const key = 'test-only-key-' + 'a'.repeat(48);
const nextKey = 'test-only-key-' + 'b'.repeat(48);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const baseConfig = { keys: [{ id: 'current', hash: hash(key) }, { id: 'next', hash: hash(nextKey) }], rateLimit: 1000, windowMs: 60000 };

async function withServer(options, run) {
  const events = [];
  const app = express();
  app.use('/api/integrations/jarvis/v1', createJarvisRouter({
    config: baseConfig, auditSink: event => events.push(event),
    getData: async (_client, endpoint, filters) => ({ data: [{ id: endpoint }], pagination: { page: filters.page, limit: filters.limit, total: 1, totalPages: 1 } }),
    ...options,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/integrations/jarvis/v1`;
    await run(async (path = '/branches', init = {}) => fetch(url + path, { ...init, headers: { 'X-API-Key': key, ...init.headers } }), events);
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test('Jarvis authenticates headers, supports overlap, and revokes old keys', async () => {
  await withServer({}, async request => {
    assert.equal((await request()).status, 200);
    assert.equal((await request('/orders', { headers: { 'X-API-Key': nextKey } })).status, 200);
    assert.equal((await request('/orders', { headers: { 'X-API-Key': '' } })).status, 401);
    assert.equal((await request('/orders', { headers: { 'X-API-Key': 'wrong' } })).status, 401);
  });
  await withServer({ config: { ...baseConfig, keys: [baseConfig.keys[1]] } }, async request => assert.equal((await request()).status, 401));
  await withServer({ config: { ...baseConfig, keys: [{ ...baseConfig.keys[0], expiresAt: '2000-01-01T00:00:00Z' }] } }, async request => assert.equal((await request()).status, 401));
  await withServer({ config: { ...baseConfig, keys: [] } }, async request => assert.equal((await request()).status, 503));
});

test('Jarvis rejects every mutation and implicit HEAD', async () => {
  await withServer({}, async request => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const response = await request('/orders', { method });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get('allow'), 'GET');
    }
  });
});

test('Jarvis validates filters and Tashkent boundaries before repository reads', async () => {
  let captured;
  await withServer({ getData: async (_client, endpoint, filters) => { captured = filters; return { data: [], pagination: { page: filters.page, limit: filters.limit, total: 0, totalPages: 0 } }; } }, async request => {
    for (const query of ['limit=201', 'page=0', 'page=1.5', 'currency=BTC', 'paymentType=OTHER', 'secret=x', 'from=2026-02-30', 'from=2026-10-09T12:00:00', 'from=2026-10-10&to=2026-10-09', 'page=1&page=2', 'apiKey=secret', 'from=2026-02-30T00:00:00Z']) {
      assert.equal((await request('/orders?' + query)).status, 400, query);
    }
    assert.equal((await request('/orders?branchCode=BR1&from=2026-10-09&to=2026-10-09&currency=UZS&paymentType=CASH&page=2&limit=10')).status, 200);
    assert.equal(captured.from.toISOString(), '2026-10-08T19:00:00.000Z');
    assert.equal(captured.to.toISOString(), '2026-10-09T18:59:59.999Z');
    assert.equal(captured.branchCode, 'BR1');
    for (const path of ['/branches?currency=UZS', '/expenses?paymentType=CARD', '/cash-balances?from=2026-10-09', '/shifts?paymentType=CARD']) assert.equal((await request(path)).status, 400, path);
  });
});

test('Jarvis throttles and audits without credentials or raw query strings', async () => {
  await withServer({ config: { ...baseConfig, rateLimit: 2 } }, async (request, events) => {
    assert.equal((await request('/orders?apiKey=do-not-log-me')).status, 400);
    assert.equal((await request()).status, 200);
    assert.equal((await request()).status, 429);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events.map(e => e.status), [400, 200, 429]);
    assert.ok(events.every(e => e.requestId && e.createdAt && e.endpoint));
    const serialized = JSON.stringify(events);
    for (const secret of [key, nextKey, 'do-not-log-me', 'X-API-Key', 'apiKey=']) assert.ok(!serialized.includes(secret));
  });
});

test('Jarvis hides repository errors and serves authenticated OpenAPI', async () => {
  await withServer({ getData: async () => { throw new Error('secret database connection'); } }, async request => {
    const response = await request('/transactions');
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes('secret'));
    assert.equal((await request('/missing')).status, 404);
    const docs = await request('/openapi.json');
    assert.equal(docs.status, 200);
    const spec = await docs.json();
    assert.equal(spec.components.securitySchemes.JarvisApiKey.name, 'X-API-Key');
    for (const endpoint of ['branches', 'orders', 'transactions', 'sales', 'cash-balances', 'shifts', 'expenses', 'inkassa']) assert.ok(spec.paths['/' + endpoint].get);
  });
});

test('OpenAPI filters and error schemas match real authenticated HTTP boundaries', async () => {
  await withServer({}, async request => {
    const spec = await (await request('/openapi.json')).json();
    assert.deepEqual(Object.keys(spec.paths).sort(), [...Object.keys(FILTERS).map(name => '/' + name), '/openapi.json'].sort());
    for (const [endpoint, filters] of Object.entries(FILTERS)) {
      assert.deepEqual(Object.keys(spec.paths['/' + endpoint]), ['get']);
      assert.deepEqual(spec.paths['/' + endpoint].get.parameters.map(parameter => parameter.name), filters);
    }
    for (const [path, init, status] of [
      ['/orders?limit=201', {}, 400],
      ['/orders', { headers: { 'X-API-Key': 'wrong' } }, 401],
      ['/orders', { method: 'POST' }, 405],
    ]) {
      const response = await request(path, init);
      assert.equal(response.status, status);
      assertResponse('orders', status, await response.json());
    }
  });
  await withServer({ config: { ...baseConfig, keys: [] } }, async request => {
    const response = await request('/orders');
    assert.equal(response.status, 503);
    assertResponse('orders', 503, await response.json());
  });
  await withServer({ config: { ...baseConfig, rateLimit: 1 } }, async request => {
    await request('/orders');
    const response = await request('/orders');
    assert.equal(response.status, 429);
    assert.ok(response.headers.get('retry-after'));
    assertResponse('orders', 429, await response.json());
  });
});

test('mounted backend preserves health/JWT boundaries and rejects CORS preflight mutations', async () => {
  const previous = process.env.JARVIS_API_KEYS;
  process.env.JARVIS_API_KEYS = JSON.stringify(baseConfig.keys);
  let server;
  try {
    const app = require('../src/app');
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const headers = { 'X-API-Key': key };
    assert.equal((await fetch(origin + '/health')).status, 200);
    assert.equal((await fetch(origin + '/api/orders', { headers })).status, 401);
    assert.equal((await fetch(origin + '/api/integrations/jarvis/v1/openapi.json', { headers })).status, 200);
    assert.equal((await fetch(origin + '/api/integrations/jarvis/v1/orders', { method: 'OPTIONS', headers: { ...headers, Origin: 'https://qonoqbaggage.uz', 'Access-Control-Request-Method': 'POST' } })).status, 405);
    assert.equal((await fetch(origin + '/api/integrations/jarvis/v1/orders', { method: 'HEAD', headers })).status, 405);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.JARVIS_API_KEYS; else process.env.JARVIS_API_KEYS = previous;
  }
});
