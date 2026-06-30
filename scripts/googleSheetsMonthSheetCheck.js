require("dotenv").config();
const appsScript = require("./googleSheetsAppsScript");

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

const run = async () => {
  const results = [];
  for (const branchCode of branchCodes) {
    for (const createdAt of testDates) {
      const expectedMonthSheetName = appsScript.monthSheetNameForDate_(createdAt);
      const response = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "CHECK_MONTH_SHEET",
          branchCode,
          createdAt,
          idempotencyKey: `CHECK_MONTH_SHEET:${branchCode}:${createdAt}`,
        }),
      });
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (error) {
        json = { parseError: error.message, raw: text.slice(0, 500) };
      }
      results.push({
        branchCode,
        createdAt,
        expectedMonthSheetName,
        httpStatus: response.status,
        success: json?.success === true && json?.ok === true && json?.sheetName === expectedMonthSheetName,
        scriptVersion: json?.scriptVersion || null,
        spreadsheetId: json?.spreadsheetId || null,
        spreadsheetName: json?.spreadsheetName || null,
        sheetName: json?.sheetName || null,
        status: json?.status || null,
        error: json?.error || json?.reason || json?.parseError || null,
      });
    }
  }

  const failed = results.filter((item) => !item.success);
  console.log(JSON.stringify({ branchCodes, testDates, total: results.length, failed: failed.length, results }, null, 2));
  if (failed.length) process.exitCode = 1;
};

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
