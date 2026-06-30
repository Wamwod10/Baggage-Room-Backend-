require("dotenv").config();
const sheets = require("../src/services/googleSheets.service");

const webhook = String(process.env.GOOGLE_SHEET_WEBHOOK || process.env.GOOGLE_SHEETS_WEBHOOK || "").trim();
if (!webhook) throw new Error("GOOGLE_SHEET_WEBHOOK is not configured");

const branchCodes = String(process.env.GOOGLE_SHEETS_TEST_BRANCHES || process.env.GOOGLE_SHEETS_TEST_BRANCH || "TIA,TSV,TJV,SVK,SIA")
  .split(",")
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean);
const testDates = String(process.env.GOOGLE_SHEETS_TEST_DATES || "2026-06-30T12:00:00+05:00,2026-07-01T12:00:00+05:00")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const batch = `GS-MAPPING-TEST-${Date.now()}`;

const casesFor = (branchCode, createdAt) => {
  const common = {
    branchCode,
    branchName: sheets._internals.branchNameByCode[branchCode],
    branch: sheets._internals.branchNameByCode[branchCode],
    createdAt,
    amountUnit: "MAJOR",
  };
  return [
    ["NEW_ORDER", {
      ...common,
      action: "NEW_ORDER",
      entityId: `${batch}:${branchCode}:${createdAt}:NEW-ORDER`,
      idempotencyKey: `${batch}:${branchCode}:${createdAt}:NEW-ORDER`,
      orderNumber: `${batch}-${branchCode}-ORDER`,
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
    ["INKASSA", {
      ...common,
      action: "INKASSA",
      entityId: `${batch}:${branchCode}:${createdAt}:INKASSA`,
      idempotencyKey: `${batch}:${branchCode}:${createdAt}:INKASSA`,
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
    ["EXPENSE", {
      ...common,
      action: "EXPENSE",
      entityId: `${batch}:${branchCode}:${createdAt}:EXPENSE`,
      idempotencyKey: `${batch}:${branchCode}:${createdAt}:EXPENSE`,
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
    ["SALARY", {
      ...common,
      action: "SALARY",
      entityId: `${batch}:${branchCode}:${createdAt}:SALARY`,
      idempotencyKey: `${batch}:${branchCode}:${createdAt}:SALARY`,
      salaryReceiver: "Vali",
      currency: "UZS",
      amount: 300000,
      salaryAmount: 300000,
      sheetAmount: 300000,
    }, (row) => {
      if (row[20] !== 300000) throw new Error(`SALARY U expected 300000, got ${row[20]}`);
      if (row[21] !== "Oylik - Vali") throw new Error(`SALARY V mismatch: ${row[21]}`);
    }],
    ["DOPLATA", {
      ...common,
      action: "DOPLATA",
      entityId: `${batch}:${branchCode}:${createdAt}:DOPLATA`,
      idempotencyKey: `${batch}:${branchCode}:${createdAt}:DOPLATA`,
      orderNumber: `${batch}-${branchCode}-DOPLATA`,
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
};

const run = async () => {
  const results = [];
  for (const branchCode of branchCodes) {
    for (const createdAt of testDates) {
      for (const [action, payload, verify] of casesFor(branchCode, createdAt)) {
        const expectedMonthSheetName = payload.monthSheetName || require("./googleSheetsAppsScript").monthSheetNameForPayload_(payload);
        try {
          const result = await sheets._internals.postWebhook({ ...payload, monthSheetName: expectedMonthSheetName });
          const parsed = result.responseJson || {};
          verify(result.finalRow);
          results.push({
            branchCode,
            action,
            createdAt,
            expectedMonthSheetName,
            status: "ok",
            scriptVersion: result.scriptVersion,
            spreadsheetId: parsed.spreadsheetId || null,
            spreadsheetName: parsed.spreadsheetName || null,
            sheetName: parsed.sheetName || null,
            row: parsed.row || null,
          });
        } catch (error) {
          results.push({
            branchCode,
            action,
            createdAt,
            expectedMonthSheetName,
            status: "failed",
            spreadsheetId: error.webhookJson?.spreadsheetId || null,
            spreadsheetName: error.webhookJson?.spreadsheetName || null,
            sheetName: error.webhookJson?.sheetName || null,
            errorStatus: error.webhookJson?.status || null,
            error: error.message,
          });
        }
      }
    }
  }

  const failed = results.filter((item) => item.status !== "ok");
  console.log(JSON.stringify({ batch, branchCodes, testDates, total: results.length, failed: failed.length, results }, null, 2));
  if (failed.length) process.exitCode = 1;
};

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
