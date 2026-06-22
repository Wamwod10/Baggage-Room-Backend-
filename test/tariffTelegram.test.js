const test = require("node:test");
const assert = require("node:assert/strict");

const { calculatePrice } = require("../src/services/tariff.service");
const {
  formatMoney,
  inkassaMessage,
  overtimePaymentMessage,
  shiftClosedMessage,
} = require("../src/utils/formatTelegramMessage");

test("72+ and manual-hour tariff calculations use Settings tariff fields", () => {
  const tariff = {
    price1h: 5000,
    price12h: 50000,
    price24h: 90000,
    price48h: 140000,
    price72h: 180000,
    after72hPrice: 30000,
  };
  assert.equal(calculatePrice(tariff, 96), 210000);
  assert.equal(calculatePrice(tariff, 75), 183750);
  assert.equal(calculatePrice(tariff, 3, { isCustom: true }), 15000);
  assert.equal(2 * calculatePrice(tariff, 75) + calculatePrice({ ...tariff, price72h: 240000, after72hPrice: 40000 }, 75), 612500);
});

test("Telegram formats decimal currencies without multiplying by 100", () => {
  assert.equal(formatMoney(21429, "RUB"), "214,29 RUB");
  assert.equal(formatMoney(1739, "TJS"), "17,39 TJS");
  assert.equal(formatMoney(12345, "USD"), "123,45 USD");
  assert.equal(formatMoney(9950, "EUR"), "99,50 EUR");
  assert.equal(formatMoney(250000, "UZS"), "250 000 so'm");
});

test("Inkassa and doplata Telegram messages use real admin and safe business identifiers", () => {
  const inkassa = inkassaMessage({
    branch: { name: "Toshkent xalqaro aeroport" },
    receiverName: "Bosh kassir",
    amount: 21429,
    currency: "RUB",
    createdBy: { name: "Ali" },
  });
  const doplata = overtimePaymentMessage({
    branch: { name: "Toshkent xalqaro aeroport" },
    orderNumber: "TIA-20260622-1001",
    clientName: "Vali",
    overtimeHours: 3,
    overtimeAmount: 45000,
    currency: "UZS",
    pickedUpBy: { name: "Ali" },
  });
  assert.match(inkassa, /🏦 Inkassa/);
  assert.match(inkassa, /Admin: Ali/);
  assert.doesNotMatch(inkassa, /Admin: Toshkent/);
  assert.match(doplata, /⚠️ Qo'shimcha to'lov/);
  assert.match(doplata, /Buyurtma: TIA-20260622-1001/);
  assert.match(doplata, /Admin: Ali/);
  assert.doesNotMatch(`${inkassa}\n${doplata}`, /undefined|null|branchId|order\.id/);
});

test("Telegram shift report separates payment and currency balances", () => {
  const message = shiftClosedMessage({
    branch: { name: "Samarqand aeroport" },
    openedBy: { name: "Ali" },
    closedBy: { name: "Vali" },
    revenueByCurrency: { UZS: 250000, RUB: 21429 },
    cashByCurrency: { UZS: 200000, RUB: 21429 },
    terminalByCurrency: { UZS: 50000 },
    clickByCurrency: { USD: 12345 },
    paymeByCurrency: { EUR: 9950 },
    debtByCurrency: {},
    expenseByCurrency: { UZS: 10000 },
    salaryByCurrency: {},
    inkassaByCurrency: { RUB: 10000 },
    cashBalanceByCurrency: { UZS: 190000, RUB: 11429 },
  });
  assert.match(message, /Click: 123,45 USD/);
  assert.match(message, /Payme: 99,50 EUR/);
  assert.match(message, /Inkassa: 100,00 RUB/);
  assert.match(message, /Yopgan admin: Vali/);
});
