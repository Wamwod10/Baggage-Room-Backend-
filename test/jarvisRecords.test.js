const test = require('node:test');
const assert = require('node:assert/strict');
const { serializeRecord, serializeSales, serializeCash } = require('../src/integrations/jarvis/serializers');
const time = new Date('2026-10-08T19:00:00.123Z');
const common = { id: 'record-1', branch: { code: 'BR1' }, createdAt: time, updatedAt: time, phone: 'secret-phone', passport: 'secret-passport', clientName: 'secret-name', note: 'secret-note', passwordHash: 'secret-password' };

test('Jarvis projections never serialize customer/staff secrets or arbitrary fields', () => {
  for (const endpoint of ['branches', 'orders', 'transactions', 'shifts', 'expenses', 'inkassa']) {
    const result = serializeRecord(endpoint, { ...common, code: 'BR1', amount: 100, currency: 'UZS', direction: 'OUT', type: 'ORDER_PAYMENT', paymentType: 'CASH', openedAt: time, closedAt: null, category: 'Oylik' });
    assert.equal(result.id, 'record-1');
    assert.equal(result.branchCode, 'BR1');
    assert.equal(result.createdAt, '2026-10-08T19:00:00.123Z');
    assert.equal(result.updatedAt, '2026-10-08T19:00:00.123Z');
    assert.ok(!JSON.stringify(result).includes('secret-'));
  }
});

test('Jarvis transaction preserves native refund direction, units and identifiers', () => {
  const result = serializeRecord('transactions', { ...common, type: 'ORDER_PAYMENT', direction: 'OUT', amount: 10, currency: 'USD', paymentType: 'CASH', orderId: 'order-1', shiftId: 'shift-1' });
  assert.equal(result.transactionId, 'record-1');
  assert.equal(result.transactionType, 'ORDER_PAYMENT');
  assert.equal(result.amount, 10);
  assert.equal(result.signedAmount, -10);
  assert.equal(result.currency, 'USD');
  assert.equal(result.orderId, 'order-1');
});

test('Jarvis salary classification omits payee while cash snapshot has explicit baseline', () => {
  assert.equal(serializeRecord('expenses', { ...common, category: 'Oylik', amount: 20, currency: 'UZS' }).isSalary, true);
  const balance = serializeCash({ id: 'branch-1', branchCode: 'BR1', currency: 'UZS', shiftId: 's1', opening: '100', accepted: '20', movementNet: '40', createdAt: time, updatedAt: time }, time);
  assert.equal(balance.balance, '160');
  assert.equal(balance.asOf, time.toISOString());
});

test('Jarvis aggregate serializes exact decimal strings beyond JS safe integer', () => {
  const row = { branchCode: 'BR1', day: '2026-10-09', currency: 'UZS', paymentType: 'CASH', grossReceipts: '9007199254740995', refunds: '10', netReceipts: '9007199254740985', transactionCount: 2n, createdAt: time, updatedAt: time };
  const result = serializeSales(row);
  assert.equal(result.netReceipts, '9007199254740985');
  assert.equal(result.grossReceipts, '9007199254740995');
  assert.equal(result.transactionCount, 2);
});
