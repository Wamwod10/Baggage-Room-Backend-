const test = require("node:test");
const assert = require("node:assert/strict");

const { _internals } = require("../src/services/order.service");
const { assertPickupTotal } = require('../src/services/financialControls');

test('edited pickup total must match actual receipts, debt payment and overtime', () => {
  const order = { currency: 'UZS', cashMovements: [{ type: 'ORDER_PAYMENT', direction: 'IN', currency: 'UZS', amount: 60000, paymentType: 'CASH' }] };
  assert.doesNotThrow(() => assertPickupTotal(order, { realPaidAmount: 80000 }, 20000, 'CASH'));
  assert.throws(() => assertPickupTotal(order, { realPaidAmount: 50000 }, 0, 'CASH'), /summa/);
  assert.doesNotThrow(() => assertPickupTotal(order, { realPaidAmount: 65000, debtPaidAmount: 5000 }, 20000, 'DEBT'));
  assert.doesNotThrow(() => assertPickupTotal(order, {}, 20000, 'CASH'));
});

test("pickup uses the manually entered overtime amount when supplied", () => {
  assert.equal(_internals.resolvePickupOvertimeAmount({ overtimeAmount: 25000 }, 10000), 25000);
  assert.equal(_internals.resolvePickupOvertimeAmount({ overtimeAmount: 0 }, 10000), 0);
});

test("pickup keeps the calculated overtime amount when no override is supplied", () => {
  assert.equal(_internals.resolvePickupOvertimeAmount({}, 10000), 10000);
});
