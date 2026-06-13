/*
 * Google Apps Script webhook for Qonoq Baggage Google Sheets.
 *
 * Why this version exists:
 * - appendRow() and getLastRow() can write far below real data when the sheet has
 *   formatting, filters, or old blank rows.
 * - This script writes to the first truly empty row by checking a key column.
 * - idempotencyKey prevents the same backend event from being written twice.
 *
 * Deploy:
 * 1. Open the Google Sheet -> Extensions -> Apps Script.
 * 2. Replace the current webhook code with this file contents, or copy the helper
 *    functions into the current doPost flow.
 * 3. Deploy -> Manage deployments -> Edit -> New version.
 * 4. Keep backend GOOGLE_SHEET_WEBHOOK / GOOGLE_SHEETS_WEBHOOK pointed to the
 *    Apps Script Web App URL.
 */

const SHEET_BY_BRANCH_CODE = {
  TIA: "TIA",
  TSV: "TSV",
  TJV: "TJV",
  SVK: "SVK",
  SIA: "SIA",
};

const HEADERS = [
  "Created At",
  "Action",
  "Branch Code",
  "Branch",
  "Order Number",
  "Client",
  "Phone",
  "Passport",
  "Lockers",
  "Check In",
  "Check Out",
  "Amount",
  "Currency",
  "Payment Type",
  "Idempotency Key",
];

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const branchCode = String(payload.branchCode || "").trim();
    const sheetName = SHEET_BY_BRANCH_CODE[branchCode];

    if (!sheetName) {
      throw new Error("Unknown branchCode: " + branchCode);
    }

    const sheet = getOrCreateSheet_(sheetName);
    ensureHeaders_(sheet);

    const idempotencyKey = String(payload.idempotencyKey || buildIdempotencyKey_(payload));
    if (hasDuplicate_(sheet, idempotencyKey)) {
      return json_({ ok: true, duplicate: true, idempotencyKey });
    }

    const row = buildRow_(payload, idempotencyKey);
    const targetRow = firstEmptyRowByColumn_(sheet, 1);
    sheet.getRange(targetRow, 1, 1, row.length).setValues([row]);

    return json_({ ok: true, row: targetRow, idempotencyKey });
  } catch (error) {
    console.error(error);
    return json_({ ok: false, error: error.message });
  }
}

function getOrCreateSheet_(name) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  return spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
}

function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    return;
  }

  const firstRow = sheet.getRange(1, 1, 1, HEADERS.length).getDisplayValues()[0];
  const hasHeader = firstRow.some((value) => String(value || "").trim());
  if (!hasHeader) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
}

function firstEmptyRowByColumn_(sheet, column) {
  const maxRows = Math.max(sheet.getMaxRows(), 2);
  const values = sheet.getRange(2, column, maxRows - 1, 1).getDisplayValues();

  for (let index = 0; index < values.length; index += 1) {
    if (!String(values[index][0] || "").trim()) {
      return index + 2;
    }
  }

  sheet.insertRowsAfter(maxRows, 20);
  return maxRows + 1;
}

function hasDuplicate_(sheet, idempotencyKey) {
  if (!idempotencyKey) return false;

  const maxRows = Math.max(sheet.getMaxRows(), 2);
  const values = sheet.getRange(2, 15, maxRows - 1, 1).getDisplayValues();
  return values.some((row) => String(row[0] || "").trim() === idempotencyKey);
}

function buildRow_(payload, idempotencyKey) {
  return [
    payload.createdAt || new Date(),
    payload.action || "",
    payload.branchCode || "",
    payload.branch || "",
    payload.orderNumber || "",
    payload.clientName || "",
    payload.phone || "",
    payload.passport || "",
    formatLockers_(payload.lockers),
    payload.checkIn || "",
    payload.checkOut || "",
    payload.amount === null || payload.amount === undefined ? "" : payload.amount,
    payload.currency || "",
    payload.paymentType || "",
    idempotencyKey || "",
  ];
}

function buildIdempotencyKey_(payload) {
  return [payload.action || "UNKNOWN", payload.branchCode || "NO_BRANCH", payload.orderNumber || payload.orderId || payload.entityId || payload.createdAt]
    .filter(Boolean)
    .join(":");
}

function formatLockers_(lockers) {
  if (!Array.isArray(lockers)) return "";
  return lockers
    .map((locker) => [locker.number, locker.size, locker.count ? "x" + locker.count : ""].filter(Boolean).join(" "))
    .join(", ");
}

function json_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
