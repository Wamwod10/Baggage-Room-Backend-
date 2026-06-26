const test = require("node:test");
const assert = require("node:assert/strict");

const { calculatePrice } = require("../src/services/tariff.service");
const { computeShiftReport, normalizeCurrencyMap } = require("../src/services/shift.service");
const {
  formatMoney,
  inkassaMessage,
  orderCancelledMessage,
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

test("Telegram admin labels do not use branch names as admin names", () => {
  const message = orderCancelledMessage({
    branch: { name: "Toshkent Shimoliy vokzal" },
    orderNumber: "TSV-000010",
    clientName: "Karazhanova Aliya",
    cancelReason: "Klient terminalda tolov qiladigan boldi",
    cancelledBy: { name: "Toshkent Shimoliy vokzal", login: "tosh_shimoliy" },
    items: [{ lockerNumber: 3 }],
    updatedAt: new Date("2026-06-26T07:30:14.000Z"),
  });

  assert.match(message, /Filial: Toshkent Shimoliy vokzal/);
  assert.match(message, /Bekor qildi: tosh_shimoliy/);
  assert.doesNotMatch(message, /Bekor qildi: Toshkent Shimoliy vokzal/);
});

test("Telegram shift report separates payment and currency balances", () => {
  const message = shiftClosedMessage({
    branch: { name: "Samarqand aeroport" },
    openedBy: { name: "Ali" },
    closedBy: { name: "Vali" },
    openingCashByCurrency: { UZS: 100000, USD: 10000 },
    acceptedCashByCurrency: { UZS: 50000, USD: 5000 },
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
  assert.match(message, /Boshlang'ich kassa: 100 000 so'm \/ 100,00 USD/);
  assert.match(message, /Qabul qilingan: 50 000 so'm \/ 50,00 USD/);
});

test("shift opening, accepted, sales, expense and inkassa remain separate by currency", async () => {
  const shift = {
    id: "shift-test",
    branchId: "branch-test",
    openedAt: new Date("2026-06-22T00:00:00Z"),
    openingCash: 100000,
    acceptedCash: 50000,
    openingCashByCurrency: { UZS: 100000, USD: 10000 },
    acceptedCashByCurrency: { UZS: 50000, USD: 5000 },
  };
  const movements = [
    { direction: "IN", type: "ORDER_PAYMENT", paymentType: "CASH", amount: 25000, currency: "UZS" },
    { direction: "IN", type: "ORDER_PAYMENT", paymentType: "CASH", amount: 2500, currency: "USD" },
    { direction: "OUT", type: "EXPENSE", paymentType: null, amount: 5000, currency: "UZS", note: "Xarajat" },
    { direction: "OUT", type: "INKASSA", paymentType: null, amount: 1000, currency: "USD", note: "Inkassa" },
  ];
  const tx = {
    cashMovement: { findMany: async () => movements },
    debt: { findMany: async () => [] },
    order: { count: async () => 1 },
  };
  const report = await computeShiftReport(tx, shift);
  assert.deepEqual(normalizeCurrencyMap(shift.openingCashByCurrency), report.openingCashByCurrency);
  assert.equal(report.cashBalanceByCurrency.UZS, 170000);
  assert.equal(report.cashBalanceByCurrency.USD, 16500);
  assert.equal(report.expenseByCurrency.UZS, 5000);
  assert.equal(report.inkassaByCurrency.USD, 1000);
});
