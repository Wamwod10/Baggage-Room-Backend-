require("dotenv").config();
const sheets = require("../src/services/googleSheets.service");

const webhook = String(process.env.GOOGLE_SHEET_WEBHOOK || process.env.GOOGLE_SHEETS_WEBHOOK || "").trim();
const branchCode = String(process.env.GOOGLE_SHEETS_TEST_BRANCH || "TIA").trim().toUpperCase();

if (!webhook) throw new Error("GOOGLE_SHEET_WEBHOOK is not configured");

const batch = `GS-MAPPING-TEST-${Date.now()}`;
const createdAt = new Date().toISOString();
const common = { branchCode, createdAt, amountUnit: "MAJOR" };

const cases = [
  ["new-order-size-counts", {
    ...common,
    action: "NEW_ORDER",
    entityId: `${batch}:NEW-ORDER`,
    idempotencyKey: `${batch}:NEW-ORDER`,
    orderNumber: `${batch}-ORDER`,
    clientName: "TEST CLIENT",
    sizeCounts: { S: 0, M: 1, L: 0, XL: 1 },
    items: [{ size: "M", count: 1 }, { size: "XL", count: 1 }],
    period: "3 soat",
    paymentType: "CASH",
    currency: "UZS",
    amount: 250000,
    sheetAmount: 250000,
  }, (row) => {
    if (row[2] !== "1-M 1-XL") throw new Error(`NEW_ORDER C expected 1-M 1-XL, got ${row[2]}`);
    if (row[5] !== 250000) throw new Error(`NEW_ORDER F expected 250000, got ${row[5]}`);
    if (String(row[2]).includes("#")) throw new Error(`NEW_ORDER C contains forbidden #: ${row[2]}`);
  }],
  ["inkassa-uzs-O", {
    ...common,
    action: "INKASSA",
    entityId: `${batch}:INKASSA`,
    idempotencyKey: `${batch}:INKASSA`,
    receiverName: "Admin",
    note: "Kunlik inkassa",
    currency: "UZS",
    amount: 500000,
    inkassaAmount: 500000,
    sheetAmount: 500000,
  }, (row) => {
    if (row[1] !== "Admin") throw new Error(`INKASSA B expected Admin, got ${row[1]}`);
    if (row[14] !== 500000) throw new Error(`INKASSA O expected 500000, got ${row[14]}`);
    if (row[5] !== "" || row[20] !== "") throw new Error("INKASSA must keep F and U empty");
    if (row[21] !== "Inkassa - Admin") throw new Error(`INKASSA V mismatch: ${row[21]}`);
  }],
  ["expense-U", {
    ...common,
    action: "EXPENSE",
    entityId: `${batch}:EXPENSE`,
    idempotencyKey: `${batch}:EXPENSE`,
    adminName: "GS Test Admin",
    category: "Internet",
    reason: "mapping test",
    currency: "UZS",
    amount: 60000,
    expenseAmount: 60000,
    sheetAmount: 60000,
  }, (row) => {
    if (row[20] !== 60000) throw new Error(`EXPENSE U expected 60000, got ${row[20]}`);
    if (row[21] !== "Internet - mapping test") throw new Error(`EXPENSE V mismatch: ${row[21]}`);
  }],
  ["salary-U", {
    ...common,
    action: "SALARY",
    entityId: `${batch}:SALARY`,
    idempotencyKey: `${batch}:SALARY`,
    salaryReceiver: "Vali",
    currency: "UZS",
    amount: 300000,
    salaryAmount: 300000,
    sheetAmount: 300000,
  }, (row) => {
    if (row[20] !== 300000) throw new Error(`SALARY U expected 300000, got ${row[20]}`);
    if (row[21] !== "Oylik - Vali") throw new Error(`SALARY V mismatch: ${row[21]}`);
  }],
  ["doplata-payme-M", {
    ...common,
    action: "DOPLATA",
    entityId: `${batch}:DOPLATA`,
    idempotencyKey: `${batch}:DOPLATA`,
    orderNumber: `${batch}-DOPLATA`,
    clientName: "TEST CLIENT",
    sizeCounts: { S: 0, M: 1, L: 0, XL: 1 },
    items: [{ size: "M", count: 1 }, { size: "XL", count: 1 }],
    doplataPeriod: "DOPLATA 3ч",
    period: "DOPLATA 3ч",
    operationName: "Доплата",
    paymentType: "PAYME",
    currency: "UZS",
    amount: 75000,
    sheetAmount: 75000,
  }, (row) => {
    if (row[12] !== 75000) throw new Error(`DOPLATA M expected 75000, got ${row[12]}`);
    if (row[4] !== "DOPLATA 3ч") throw new Error(`DOPLATA E mismatch: ${row[4]}`);
  }],
];

const run = async () => {
  const results = [];
  for (const [name, payload, verify] of cases) {
    const result = await sheets._internals.postWebhook(payload);
    const parsed = result.responseJson || {};
    verify(result.finalRow);
    results.push({
      name,
      scriptVersion: result.scriptVersion,
      sheetRow: parsed.row,
      finalRow: result.finalRow,
    });
  }
  console.log(JSON.stringify({ batch, branchCode, results }, null, 2));
};

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
