const test = require("node:test");
const assert = require("node:assert/strict");

const { _internals } = require("../src/services/order.service");

test("pickup uses the manually entered overtime amount when supplied", () => {
  assert.equal(_internals.resolvePickupOvertimeAmount({ overtimeAmount: 25000 }, 10000), 25000);
  assert.equal(_internals.resolvePickupOvertimeAmount({ overtimeAmount: 0 }, 10000), 0);
});

test("pickup keeps the calculated overtime amount when no override is supplied", () => {
  assert.equal(_internals.resolvePickupOvertimeAmount({}, 10000), 10000);
});
