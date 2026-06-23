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
    [123.45, "USD", 123.45],
    [99.5, "EUR", 99.5],
    [17.39, "TJS", 17.39],
    [125.75, "KZT", 125.75],
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
  assert.equal(row[COLUMN.NAME - 1], "Хранение багажа");
  assert.equal(row.length, 22);
  assert.doesNotMatch(row[COLUMN.PLACE - 1], /#/);
});

test("legacy place fallback strips hash signs from column C", () => {
  assert.equal(appsScript.formatPlaces_({ place: "#1-S #2-M #1-L" }), "1-S 2-M 1-L");
});

test("EXPENSE, SALARY and INKASSA map only to their financial blocks", () => {
  const expense = sheets._internals.expensePayload({
    id: "expense-test",
    branch: { code: "TSV", name: "Shimoliy vokzal" },
    category: "Transport",
    reason: "Taxi",
    amount: parseCurrency(99.5, "EUR"),
    currency: "EUR",
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
  assert.equal(expenseRow[COLUMN.EXPENSE - 1], 99.5);
  assert.match(expenseRow[COLUMN.NAME - 1], /Transport - Taxi/);
  assert.equal(expenseRow[COLUMN.CHECK - 1], "");
  assert.equal(salaryRow[COLUMN.EXPENSE - 1], 250000);
  assert.equal(salaryRow[COLUMN.FIO - 1], "Ali");
  assert.equal(salaryRow[COLUMN.NAME - 1], "Oylik - Ali");
  assert.equal(inkassaRow[COLUMN.BALANCE_USD - 1], 123.45);
  assert.equal(inkassaRow[COLUMN.EXPENSE - 1], "");
  assert.equal(inkassaRow[COLUMN.NAME - 1], "Inkassa USD - Bosh kassir");
  assert.deepEqual(inkassaRow.slice(COLUMN.CASH_UZS - 1, COLUMN.TERMINAL), new Array(9).fill(""));
  assert.deepEqual(salaryRow.slice(COLUMN.CASH_UZS - 1, COLUMN.TERMINAL), new Array(9).fill(""));
});

test("INKASSA currencies use O-T only and never F-N revenue columns", () => {
  const expectedColumns = {
    UZS: COLUMN.BALANCE_UZS,
    USD: COLUMN.BALANCE_USD,
    EUR: COLUMN.BALANCE_EUR,
    RUB: COLUMN.BALANCE_RUB,
    KZT: COLUMN.BALANCE_KZT,
    TJS: COLUMN.BALANCE_TJS,
  };
  for (const [currency, column] of Object.entries(expectedColumns)) {
    const payload = sheets._internals.inkassaPayload({
      id: `inkassa-${currency}`,
      branch: { code: "TIA", name: "Toshkent aeroport" },
      receiverName: "Ali",
      amount: parseCurrency(currency === "UZS" ? 250000 : 17.39, currency),
      currency,
    });
    const row = appsScript.buildLegacyRow_(payload);
    assert.equal(row[column - 1], currency === "UZS" ? 250000 : 17.39);
    assert.deepEqual(row.slice(COLUMN.CASH_UZS - 1, COLUMN.TERMINAL), new Array(9).fill(""));
  }
});

test("orders and doplata alone can write F-K, Click, Payme and Terminal revenue columns", () => {
  const cases = [
    ["CASH", "UZS", COLUMN.CASH_UZS],
    ["CASH", "USD", COLUMN.CASH_USD],
    ["CASH", "EUR", COLUMN.CASH_EUR],
    ["CASH", "RUB", COLUMN.CASH_RUB],
    ["CASH", "KZT", COLUMN.CASH_KZT],
    ["CASH", "TJS", COLUMN.CASH_TJS],
    ["CLICK", "UZS", COLUMN.CLICK],
    ["PAYME", "UZS", COLUMN.PAYME],
    ["TERMINAL", "UZS", COLUMN.TERMINAL],
  ];
  for (const [paymentType, currency, column] of cases) {
    const payload = sheets._internals.orderPayload("NEW_ORDER", {
      id: `${paymentType}-${currency}`,
      branch: { code: "TIA", name: "Toshkent aeroport" },
      orderNumber: `TEST-${paymentType}-${currency}`,
      clientName: "Test",
      items: [{ size: "S", count: 1 }],
      finalAmount: parseCurrency(currency === "UZS" ? 1000 : 10.25, currency),
      currency,
      paymentType,
    });
    const row = appsScript.buildLegacyRow_(payload);
    assert.equal(row[column - 1], currency === "UZS" ? 1000 : 10.25);
  }
});

test("each action builder returns an exact A:V row with isolated financial columns", () => {
  const common = { createdAt: "2026-06-23T10:00:00+05:00", sheetAmount: "214,29", currency: "RUB" };
  const order = appsScript.buildOrderRow({
    ...common,
    action: "NEW_ORDER",
    clientName: "Ali",
    orderNumber: "TIA-22",
    lockers: [{ size: "S", count: 1 }],
    period: "3 soat",
    paymentType: "CASH",
  });
  const doplata = appsScript.buildDoplataRow({
    ...common,
    action: "DOPLATA",
    clientName: "Ali",
    orderNumber: "TIA-22",
    doplataPeriod: "ДОПЛАТА 3ч",
    paymentType: "PAYME",
  });
  const expense = appsScript.buildExpenseRow({
    action: "EXPENSE",
    createdAt: common.createdAt,
    category: "Internet",
    reason: "oylik to'lov",
    adminName: "Admin",
    currency: "UZS",
    sheetAmount: "60 000",
  });
  const salary = appsScript.buildSalaryRow({
    action: "SALARY",
    createdAt: common.createdAt,
    salaryReceiver: "Vali",
    currency: "UZS",
    sheetAmount: 250000,
  });
  const inkassa = appsScript.buildInkassaRow({
    action: "INKASSA",
    createdAt: common.createdAt,
    receiverName: "Murod aka",
    currency: "RUB",
    sheetAmount: "214,29",
  });

  for (const row of [order, doplata, expense, salary, inkassa]) assert.equal(row.length, 22);
  assert.equal(order[COLUMN.CASH_RUB - 1], 214.29);
  assert.equal(doplata[COLUMN.PAYME - 1], 214.29);
  assert.equal(doplata[COLUMN.PERIOD - 1], "ДОПЛАТА 3ч");
  assert.equal(expense[COLUMN.FIO - 1], "Admin");
  assert.equal(expense[COLUMN.EXPENSE - 1], 60000);
  assert.equal(expense[COLUMN.NAME - 1], "Internet - oylik to'lov");
  assert.equal(salary[COLUMN.EXPENSE - 1], 250000);
  assert.equal(salary[COLUMN.CHECK - 1], "");
  assert.equal(salary[COLUMN.PERIOD - 1], "");
  assert.equal(inkassa[COLUMN.BALANCE_RUB - 1], 214.29);
  assert.equal(inkassa[COLUMN.EXPENSE - 1], "");
  assert.equal(inkassa[COLUMN.NAME - 1], "Inkassa RUB - Murod aka");
  assert.deepEqual(expense.slice(COLUMN.CASH_UZS - 1, COLUMN.TERMINAL), new Array(9).fill(""));
  assert.deepEqual(salary.slice(COLUMN.BALANCE_UZS - 1, COLUMN.BALANCE_TJS), new Array(6).fill(""));
  assert.deepEqual(inkassa.slice(COLUMN.CASH_UZS - 1, COLUMN.TERMINAL), new Array(9).fill(""));
});

test("localized decimal strings stay decimals instead of becoming 100x larger", () => {
  assert.equal(appsScript.parseNumber_("214,29"), 214.29);
  assert.equal(appsScript.parseNumber_("17,39"), 17.39);
  assert.equal(appsScript.parseNumber_("250 000"), 250000);
  assert.equal(appsScript.amountAbs_(21429, "RUB"), 214.29);
  assert.equal(appsScript.amountAbs_("214,29", "RUB"), 214.29);
  assert.equal(sheets._internals.sheetAmount(21429, "RUB"), 214.29);
  assert.equal(sheets._internals.sheetAmount("214,29", "RUB"), 214.29);
  assert.equal(sheets._internals.sheetAmount("17,39", "TJS"), 17.39);
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
