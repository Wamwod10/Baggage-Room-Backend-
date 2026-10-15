const test = require('node:test');
const assert = require('node:assert/strict');
const controls = require('../src/services/financialControls');

test('recorded non-debt price difference is a discount, without hiding refunds or missing receipts', () => {
  const order = { currency: 'UZS', paymentType: 'CASH', calculatedAmount: 112000,
    discountAmount: 0, finalAmount: 112000, realPaidAmount: 60000, paymentDifference: -52000,
    cashMovements: [{ type: 'ORDER_PAYMENT', direction: 'IN', currency: 'UZS', amount: 60000, paymentType: 'CASH' }] };
  const discounted = controls.withRecordedDiscount(order);
  assert.equal(discounted.discountAmount, 52000);
  assert.equal(discounted.finalAmount, 60000);
  assert.equal(discounted.paymentDifference, 0);
  assert.doesNotThrow(() => controls.assertPickupPaid(discounted));
  for (const changed of [ { paymentType: 'DEBT' }, { cashMovements: [] },
    { cashMovements: [...order.cashMovements, { type: 'ORDER_PAYMENT', direction: 'OUT', currency: 'UZS', amount: 1, paymentType: 'CASH' }] } ]) {
    assert.equal(controls.withRecordedDiscount({ ...order, ...changed }).finalAmount, 112000);
  }
  assert.equal(controls.withRecordedDiscount({ ...order, realPaidAmount: 0, paymentDifference: -112000 }).finalAmount, 112000);
});

test('pickup blocks zero, partial and refunded receipts; discounts reduce required amount', () => {
  const order = { currency: 'UZS', finalAmount: 100, cashMovements: [] };
  assert.throws(() => controls.assertPickupPaid(order), /to‘liq/);
  order.cashMovements = [{ type: 'ORDER_PAYMENT', direction: 'IN', currency: 'UZS', amount: 99, paymentType: 'CASH' }];
  assert.throws(() => controls.assertPickupPaid(order), /to‘liq/);
  order.cashMovements[0].amount = 100;
  assert.doesNotThrow(() => controls.assertPickupPaid(order));
  order.cashMovements.push({ type: 'ORDER_PAYMENT', direction: 'OUT', currency: 'UZS', amount: 10, paymentType: 'CASH' });
  assert.throws(() => controls.assertPickupPaid(order), /to‘liq/);
  order.finalAmount = 90;
  assert.doesNotThrow(() => controls.assertPickupPaid(order));
});
test('only existing formal debt is a pickup exception; currencies cannot be added', () => {
  const order = { currency: 'UZS', finalAmount: 100, paymentType: 'DEBT', cashMovements: [] };
  assert.throws(() => controls.assertPickupPaid(order));
  order.debt = { status: 'OPEN', currency: 'UZS', amount: 100 };
  assert.doesNotThrow(() => controls.assertPickupPaid(order));
  order.debt.amount = 50;
  assert.throws(() => controls.assertPickupPaid(order));
  order.paymentType = 'CASH';
  order.debt = null;
  order.cashMovements = [{ type: 'ORDER_PAYMENT', direction: 'IN', amount: 100, currency: 'USD', paymentType: 'CASH' }];
  assert.throws(() => controls.assertPickupPaid(order));
});
test('price permission uses actual account allowlist and mandatory reason', () => {
  assert.throws(() => controls.assertPricePermission({ id: 'employee', role: 'UNKNOWN' }, 'reason', 'manager'), /huquqi/);
  assert.throws(() => controls.assertPricePermission({ id: 'employee', role: 'BRANCH_ADMIN' }, 'reason', 'manager'), /huquqi/);
  assert.doesNotThrow(() => controls.assertPricePermission({ id: 'leader', role: 'SUPER_ADMIN' }, 'reason', ''));
  assert.throws(() => controls.assertPricePermission({ id: 'leader', role: 'SUPER_ADMIN' }, ' ', ''), /sabab/);
  assert.throws(() => controls.assertPricePermission({ id: 'manager' }, ' ', 'manager'), /sabab/);
  assert.doesNotThrow(() => controls.assertPricePermission({ id: 'manager' }, 'reason', 'manager'));
});
test('structured baggage rejects zero, negative, fractional and airport XL', () => {
  for (const count of [0, -1, 1.5]) assert.throws(() => controls.validateBaggage([{ size: 'S', count }], 'TIA'));
  assert.throws(() => controls.validateBaggage([{ size: 'XL', count: 1 }], 'TIA'));
  assert.throws(() => controls.validateBaggage([], 'TSV'));
  assert.equal(controls.validateBaggage([{ size: 'S', count: 2 }, { size: 'XL', count: 1 }], 'SVK'), 3);
});
test('currency conversion rounds a mathematical half exactly in integer minor units', () => {
  assert.equal(require('../src/utils/money').convertUzsToCurrencyMinor(23, 'USD', 40), 58);
});
