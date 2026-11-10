const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTelegramSalesSummary, convertForeignToUzs } = require("../src/services/telegramSalesReport.service");
const { shiftSalesSnapshotMessage } = require("../src/utils/formatTelegramMessage");

const cash = (amount, currency, rate, paymentType = "CASH", direction = "IN") => ({
  type: "ORDER_PAYMENT", direction, amount, currency, paymentType,
  order: currency === "UZS" ? null : { currency, exchangeRate: rate },
});

test("Telegram sale report matches manager's UZS total and separate foreign currencies", () => {
  const sales = buildTelegramSalesSummary([
    cash(500000, "UZS", null),
    cash(5000, "USD", 11500), // 50 USD -> 575000 UZS
    cash(10000, "RUB", "130.0000000000"), // 100 RUB -> 13000 UZS
    cash(680000, "UZS", null, "TERMINAL"),
  ]);
  assert.equal(sales.totalUzs, 1768000);
  assert.equal(sales.cashUzs, 500000);
  assert.equal(sales.terminalUzs, 680000);
  assert.equal(sales.foreign[0].uzs, 575000);
  assert.equal(sales.foreign[1].uzs, 13000);
  assert.equal(sales.hasUnknownRates, false);
  const text = shiftSalesSnapshotMessage({ telegramSalesSummary: sales });
  assert.match(text, /Jami tushum: 1 768 000 so'm/);
  assert.match(text, /Naqd pul: 500 000 so'm/);
  assert.match(text, /Chet el valyutasidagi to'lovlar:\n50\$ - 575 000 so'm\n100₽ - 13 000 so'm/);
  assert.match(text, /Terminal orqali: 680 000 so'm/);
  assert.match(text, /Payme orqali: 0 so'm/);
  assert.match(text, /Click orqali: 0 so'm/);
  assert.doesNotMatch(text, /курс не указан|kurs topilmadi|Naqd:.*USD/);
});

test("reported revenue subtracts cancellation reversals and includes debt closes", () => {
  const rows = [
    cash(250000, "UZS", null, "CASH"),
    cash(5000, "USD", "11500.00"),
    cash(5000, "USD", "11500.00", "CASH", "OUT"),
    cash(10000, "RUB", "130.00"),
    { ...cash(90000, "UZS", null, "PAYME"), type: "DEBT_CLOSE" },
    { ...cash(50000, "UZS", null, "CLICK"), type: "DEBT_CLOSE" },
    { ...cash(15000, "UZS", null, "CASH"), type: "EXPENSE" },
  ];
  const sales = buildTelegramSalesSummary(rows);
  assert.equal(sales.totalUzs, 403000);
  assert.equal(sales.paymeUzs, 90000);
  assert.equal(sales.clickUzs, 50000);
  assert.equal(sales.cashUzs, 250000);
  assert.equal(sales.foreign.find(x=>x.currency==="RUB").uzs,13000);
  assert.ok(!sales.foreign.some(x=>x.currency==="USD"), "reversed USD does not appear");
});

test("different historical rates are applied per movement, not averaged or fetched live", () => {
  const sales = buildTelegramSalesSummary([
    cash(2000, "USD", "11500"), // 20 -> 230000
    cash(3000, "USD", "12500"), // 30 -> 375000
    cash(25000, "UZS", null, "CARD"),
    cash(25000, "UZS", null, "TRANSFER"),
  ]);
  assert.equal(sales.foreign[0].amountMinor, 5000);
  assert.equal(sales.foreign[0].uzs, 605000);
  assert.equal(sales.totalUzs, 655000);
  assert.equal(sales.terminalUzs, 50000);
});

test("missing FX rate is visible and never silently added to a fake total", () => {
  const sales = buildTelegramSalesSummary([cash(100000, "UZS", null), cash(5000, "USD", null)]);
  assert.equal(sales.totalUzs, 100000);
  assert.equal(sales.hasUnknownRates, true);
  const text = shiftSalesSnapshotMessage({ telegramSalesSummary: sales });
  assert.match(text, /ayirboshlash kursi yetishmaydi, jami to'liq emas/);
  assert.match(text, /50\$ - kurs topilmadi/);
  assert.doesNotMatch(text, /50\$ - 0 so'm/);
});

test("foreign payment with mismatched order currency is not converted using unrelated rate", () => {
  const row = cash(10000, "RUB", 12500);
  row.order.currency = "USD";
  assert.equal(buildTelegramSalesSummary([row]).hasUnknownRates, true);
});

test("foreign minor-unit conversion is precise and signed", () => {
  assert.equal(convertForeignToUzs(5000, "USD", "11500"), 575000);
  assert.equal(convertForeignToUzs(-5000, "USD", "11500"), -575000);
  assert.equal(convertForeignToUzs(10000, "RUB", "130"), 13000);
  assert.equal(convertForeignToUzs(100, "TJS", "1150.00"), 1150);
  assert.equal(convertForeignToUzs(1, "USD", "12500"), 125);
  assert.equal(convertForeignToUzs(1000, "USD", "0"), null);
});
