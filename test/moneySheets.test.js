const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeCurrencyAmount,
  parseCurrency,
} = require("../src/utils/money");
const sheets = require("../src/services/googleSheets.service");
const appsScript = require("../scripts/googleSheetsAppsScript");
const { amount: amountSchema } = require("../src/utils/validation");

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

test("inkassa amount parser preserves spaced and plain UZS amounts", () => {
  assert.equal(amountSchema.parse("500 000"), 500000);
  assert.equal(amountSchema.parse("500000"), 500000);
  assert.equal(amountSchema.parse("5"), 5);
});

test("NEW_ORDER M=1 XL=1 writes only 1-M 1-XL to column C", () => {
  const payload = sheets._internals.orderPayload("NEW_ORDER", {
    id: "order-test",
    branch: { code: "TIA", name: "Toshkent aeroport" },
    orderNumber: "TIA-1001",
    clientName: "Test Client",
    tariffHours: 75,
    items: [
      { size: "M", count: 1, lockerNumber: 21 },
      { size: "XL", count: 1, locker: { number: 25, size: "XL" } },
    ],
    finalAmount: parseCurrency(214.29, "RUB"),
    currency: "RUB",
    paymentType: "CASH",
  });
  const row = appsScript.buildLegacyRow_(payload);

  assert.deepEqual(payload.sizeCounts, { S: 0, M: 1, L: 0, XL: 1 });
  assert.equal(row[COLUMN.PLACE - 1], "1-M 1-XL");
  assert.equal(row[COLUMN.CHECK - 1], "TIA-1001");
  assert.equal(row[COLUMN.PERIOD - 1], "75 soat");
  assert.equal(row[COLUMN.CASH_RUB - 1], 214.29);
  assert.equal(row[COLUMN.NAME - 1], "Хранение багажа");
  assert.equal(row.length, 22);
  assert.doesNotMatch(row[COLUMN.PLACE - 1], /#/);
});

test("NEW_ORDER sends real paid amount when present and calculated final amount otherwise", () => {
  assert.equal(sheets._internals.newOrderSheetAmount({ realPaidAmount: 175000, finalAmount: 200000 }), 175000);
  assert.equal(sheets._internals.newOrderSheetAmount({ realPaidAmount: 0, finalAmount: 200000 }), 0);
  assert.equal(sheets._internals.newOrderSheetAmount({ realPaidAmount: null, finalAmount: 200000 }), 200000);
  assert.equal(sheets._internals.newOrderSheetAmount({ calculatedAmount: 220000 }), 220000);

  const payload = sheets._internals.orderPayload("NEW_ORDER", {
    id: "real-paid-order",
    branch: { code: "TIA", name: "Toshkent aeroport" },
    orderNumber: "TIA-REAL-PAID",
    clientName: "Test Client",
    tariffHours: 3,
    items: [{ size: "M", count: 1 }],
    finalAmount: 200000,
    realPaidAmount: 175000,
    currency: "UZS",
    paymentType: "CASH",
  }, { amount: sheets._internals.newOrderSheetAmount({ realPaidAmount: 175000, finalAmount: 200000 }) });

  const row = appsScript.buildNewOrderRow(payload);
  assert.equal(row[COLUMN.CASH_UZS - 1], 175000);
});

test("column C falls back only to items and never to locker numbers or legacy # text", () => {
  assert.equal(appsScript.formatSizeCounts_({
    items: [
      { size: "M", count: 1, lockerNumber: 21 },
      { locker: { size: "XL", number: 25 }, count: 1 },
    ],
    lockers: [{ size: "S", lockerNumber: 99 }],
    place: "#21-M #-XL",
  }), "1-M 1-XL");
  assert.equal(appsScript.formatSizeCounts_({ place: "#-M #-XL", lockers: [{ size: "M" }] }), "");
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
  assert.equal(inkassaRow[COLUMN.NAME - 1], "Inkassa - Bosh kassir");
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

test("backend accepts only versioned 22-column INKASSA webhook results", () => {
  const payload = sheets._internals.inkassaPayload({
    id: "inkassa-result-test",
    branch: { code: "TJV", name: "Toshkent Janubiy vokzal" },
    receiverName: "Admin",
    amount: 500000,
    currency: "UZS",
  });
  const row = appsScript.buildInkassaRow(payload);
  const result = sheets._internals.validateWebhookResult(payload, {
    success: true,
    scriptVersion: "v4-final-sheets-mapping-2026-06-24",
    branchCode: "TJV",
    spreadsheetId: "10-h62nZAEp-puvFF_MurFu1UE0Xdjdx5Qtlv3Qpd0L8",
    spreadsheetName: "Toshkent Janubiy vokzal",
    sheetName: "Камера хранения Южный вокзал 🛅",
    row: 1885,
  });

  assert.equal(appsScript.SCRIPT_VERSION, "v4-final-sheets-mapping-2026-06-24");
  assert.equal(result.scriptVersion, "v4-final-sheets-mapping-2026-06-24");
  assert.equal(result.row[14], 500000);
  assert.deepEqual(result.row.slice(5, 14), new Array(9).fill(""));
  assert.throws(
    () => sheets._internals.validateWebhookResult(payload, { success: true, finalRow: row }),
    /script version mismatch/,
  );
  assert.throws(
    () => sheets._internals.validateWebhookResult(payload, {
      success: true,
      scriptVersion: "v4-final-sheets-mapping-2026-06-24",
      branchCode: "TJV",
      row: 1885,
    }),
    /spreadsheet mismatch/,
  );

  const wrongRow = [...row];
  wrongRow[5] = 500000;
  assert.throws(
    () => sheets._internals.validateWebhookResult(payload, {
      success: true,
      scriptVersion: "v4-final-sheets-mapping-2026-06-24",
      branchCode: "TJV",
      spreadsheetId: "10-h62nZAEp-puvFF_MurFu1UE0Xdjdx5Qtlv3Qpd0L8",
      spreadsheetName: "Toshkent Janubiy vokzal",
      sheetName: "Камера хранения Южный вокзал 🛅",
      row: 1886,
      finalRow: wrongRow,
    }),
    /must not write to revenue columns F:N/,
  );
});

test("Janubiy vokzal aliases normalize to TJV and use its dedicated spreadsheet", () => {
  const aliases = [
    "TJV",
    "TJV ",
    "TJW",
    "Toshkent Janubiy vokzal",
    "Тошкент Жанубий вокзал",
    "Камера хранения Южный вокзал",
    "Камера хранения Южный вокзал 🛅",
  ];
  for (const alias of aliases) {
    assert.equal(sheets._internals.normalizeBranchCode(alias), "TJV");
    assert.equal(appsScript.normalizeBranchCode_(alias), "TJV");
  }
  assert.equal(appsScript.SHEETS.TJV, "10-h62nZAEp-puvFF_MurFu1UE0Xdjdx5Qtlv3Qpd0L8");
  assert.equal(
    sheets._internals.EXPECTED_SPREADSHEET_ID_BY_BRANCH_CODE.TJV,
    "10-h62nZAEp-puvFF_MurFu1UE0Xdjdx5Qtlv3Qpd0L8",
  );
  const maskedWebhook = sheets._internals.maskWebhookUrl("https://script.google.com/macros/s/1234567890abcdefghijkl/exec");
  assert.equal(maskedWebhook.slice(-20), "67890abcdefghijkl/exec".slice(-20));
  assert.doesNotMatch(maskedWebhook.slice(0, -20), /script\.google/);
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

test("required NEW_ORDER, INKASSA, EXPENSE, SALARY and DOPLATA A:V mappings are exact", () => {
  const createdAt = "2026-06-24T10:00:00+05:00";
  const order = appsScript.buildNewOrderRow({
    action: "NEW_ORDER",
    createdAt,
    clientName: "Ali",
    orderNumber: "TIA-22",
    sizeCounts: { S: 0, M: 1, L: 0, XL: 1 },
    period: "3 soat",
    paymentType: "CASH",
    currency: "UZS",
    sheetAmount: 250000,
  });
  const inkassa = appsScript.buildInkassaRow({
    action: "INKASSA",
    createdAt,
    receiverName: "Admin",
    note: "Kunlik inkassa",
    currency: "UZS",
    sheetAmount: 500000,
  });
  const expense = appsScript.buildExpenseRow({
    action: "EXPENSE",
    createdAt,
    category: "Internet",
    reason: "oylik to'lov",
    adminName: "Admin",
    currency: "UZS",
    sheetAmount: 60000,
  });
  const salary = appsScript.buildSalaryRow({
    action: "SALARY",
    createdAt,
    salaryReceiver: "Vali",
    currency: "UZS",
    sheetAmount: 300000,
  });
  const doplata = appsScript.buildDoplataRow({
    action: "DOPLATA",
    createdAt,
    clientName: "Ali",
    orderNumber: "TIA-22",
    sizeCounts: { S: 0, M: 1, L: 0, XL: 1 },
    doplataPeriod: "DOPLATA 3ч",
    paymentType: "PAYME",
    currency: "UZS",
    sheetAmount: 75000,
  });

  for (const row of [order, inkassa, expense, salary, doplata]) assert.equal(row.length, 22);

  assert.equal(order[COLUMN.PLACE - 1], "1-M 1-XL");
  assert.equal(order[COLUMN.CASH_UZS - 1], 250000);
  assert.equal(order[COLUMN.NAME - 1], "Хранение багажа");

  assert.equal(inkassa[COLUMN.FIO - 1], "Admin");
  assert.equal(inkassa[COLUMN.BALANCE_UZS - 1], 500000);
  assert.equal(inkassa[COLUMN.NAME - 1], "Inkassa - Admin");
  assert.deepEqual(inkassa.slice(COLUMN.CASH_UZS - 1, COLUMN.TERMINAL), new Array(9).fill(""));
  assert.equal(inkassa[COLUMN.EXPENSE - 1], "");

  assert.equal(expense[COLUMN.FIO - 1], "Admin");
  assert.equal(expense[COLUMN.EXPENSE - 1], 60000);
  assert.equal(expense[COLUMN.NAME - 1], "Internet - oylik to'lov");

  assert.equal(salary[COLUMN.FIO - 1], "Vali");
  assert.equal(salary[COLUMN.EXPENSE - 1], 300000);
  assert.equal(salary[COLUMN.NAME - 1], "Oylik - Vali");

  assert.equal(doplata[COLUMN.PAYME - 1], 75000);
  assert.equal(doplata[COLUMN.PERIOD - 1], "DOPLATA 3ч");
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
