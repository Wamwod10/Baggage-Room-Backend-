const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeCurrencyAmount,
  parseCurrency,
} = require("../src/utils/money");
const sheets = require("../src/services/googleSheets.service");
const appsScript = require("../scripts/googleSheetsAppsScript");

const { COLUMN } = appsScript;

test("decimal currency minor units normalize to exact Google Sheets major numbers", () => {
  const cases = [
    [214.29, "RUB", 214.29],
    [17.39, "TJS", 17.39],
    [123.45, "USD", 123.45],
    [99.5, "EUR", 99.5],
    [250000, "UZS", 250000],
  ];

  for (const [input, currency, expected] of cases) {
    const minor = parseCurrency(input, currency);
    assert.equal(normalizeCurrencyAmount(minor, currency), expected);
  }
});

test("NEW_ORDER keeps baggage places, check and period in their own columns", () => {
  const payload = sheets._internals.orderPayload("NEW_ORDER", {
    id: "order-test",
    branch: { code: "TIA", name: "Toshkent aeroport" },
    orderNumber: "TIA-1001",
    clientName: "Test Client",
    tariffHours: 75,
    items: [
      { size: "S", count: 1 },
      { size: "M", count: 2 },
      { size: "L", count: 1 },
    ],
    finalAmount: parseCurrency(214.29, "RUB"),
    currency: "RUB",
    paymentType: "CASH",
  });
  const row = appsScript.buildLegacyRow_(payload);

  assert.equal(row[COLUMN.PLACE - 1], "1-S 2-M 1-L");
  assert.equal(row[COLUMN.CHECK - 1], "TIA-1001");
  assert.equal(row[COLUMN.PERIOD - 1], "75 soat");
  assert.equal(row[COLUMN.CASH_RUB - 1], 214.29);
});

test("EXPENSE, SALARY and INKASSA map only to their financial blocks", () => {
  const expense = sheets._internals.expensePayload({
    id: "expense-test",
    branch: { code: "TSV", name: "Shimoliy vokzal" },
    category: "Transport",
    reason: "Taxi",
    amount: parseCurrency(17.39, "TJS"),
    currency: "TJS",
  });
  const salary = sheets._internals.salaryPayload({
    salaryEntityId: "salary-test",
    branch: { code: "TJV", name: "Janubiy vokzal" },
    salaryReceiver: "Ali",
    salaryAmount: 250000,
    currency: "UZS",
  });
  const inkassa = sheets._internals.inkassaPayload({
    id: "inkassa-test",
    branch: { code: "SIA", name: "Samarqand aeroport" },
    receiverName: "Bosh kassir",
    amount: parseCurrency(123.45, "USD"),
    currency: "USD",
  });

  const expenseRow = appsScript.buildLegacyRow_(expense);
  const salaryRow = appsScript.buildLegacyRow_(salary);
  const inkassaRow = appsScript.buildLegacyRow_(inkassa);
  assert.equal(expenseRow[COLUMN.EXPENSE - 1], 17.39);
  assert.match(expenseRow[COLUMN.NAME - 1], /Transport - Taxi/);
  assert.equal(expenseRow[COLUMN.CHECK - 1], "");
  assert.equal(salaryRow[COLUMN.EXPENSE - 1], 250000);
  assert.equal(salaryRow[COLUMN.NAME - 1], "Oylik - Ali");
  assert.equal(inkassaRow[COLUMN.BALANCE_USD - 1], 123.45);
  assert.equal(inkassaRow[COLUMN.EXPENSE - 1], "");
});

test("all five branch codes build every supported Sheets action", () => {
  const branches = ["TIA", "TSV", "TJV", "SVK", "SIA"];
  const actions = ["NEW_ORDER", "DOPLATA", "EXPENSE", "INKASSA", "SALARY"];
  for (const branchCode of branches) {
    for (const action of actions) {
      const payload = sheets._internals.testPayload(action, branchCode, null, { name: "Ali" });
      assert.equal(payload.branchCode, branchCode);
      assert.equal(payload.action, action);
      assert.equal(appsScript.buildLegacyRow_(payload).length, 22);
    }
  }
});
