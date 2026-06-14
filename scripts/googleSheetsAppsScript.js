/*
 * Google Apps Script webhook for Qonoq Baggage Google Sheets.
 *
 * Why this version exists:
 * - appendRow() and getLastRow() can write far below real data when the sheet has
 *   formatting, filters, or old blank rows.
 * - This script writes after the last real order row instead of using appendRow().
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
  "Recipient",
  "Note",
  "Section",
  "Idempotency Key",
];

const ACTION_STYLE = {
  EXPENSE: {
    background: "#f4cccc",
    fontColor: "#7f1d1d",
  },
  SALARY: {
    background: "#fce4d6",
    fontColor: "#7f1d1d",
  },
  DEBT_CLOSED: {
    background: "#d9ead3",
    fontColor: "#274e13",
  },
};

const WRITABLE_ACTIONS = new Set(["NEW_ORDER", "EXPENSE", "SALARY"]);

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const action = String(payload.action || "").toUpperCase();

    if (!WRITABLE_ACTIONS.has(action)) {
      return json_({ ok: true, skipped: true, reason: "Google Sheets only accepts NEW_ORDER, EXPENSE, SALARY events" });
    }

    const branchCode = String(payload.branchCode || "").trim();
    const sheetName = SHEET_BY_BRANCH_CODE[branchCode];

    if (!sheetName) {
      throw new Error("Unknown branchCode: " + branchCode);
    }

    const sheet = getOrCreateSheet_(sheetName);

    const idempotencyKey = String(payload.idempotencyKey || buildIdempotencyKey_(payload));
    if (hasDuplicate_(sheet, idempotencyKey)) {
      return json_({ ok: true, duplicate: true, idempotencyKey });
    }

    const isLegacy = isLegacyQonoqSheet_(sheet);
    if (!isLegacy) {
      ensureHeaders_(sheet);
    }

    const row = isLegacy ? buildLegacyRow_(payload, idempotencyKey) : buildRow_(payload, idempotencyKey);
    const targetRow = findNextOrderRow(sheet);
    sheet.getRange(targetRow, 1, 1, row.length).setValues([row]);
    styleRow_(sheet, targetRow, payload.action, row.length);

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
  ensureColumns_(sheet, HEADERS.length);
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

function ensureColumns_(sheet, minColumns) {
  const currentColumns = sheet.getMaxColumns();
  if (currentColumns < minColumns) {
    sheet.insertColumnsAfter(currentColumns, minColumns - currentColumns);
  }
}

function firstEmptyRowByColumn_(sheet, column) {
  return firstDataRowAfterContent_(sheet, 2, [column]);
}

function findNextOrderRow(sheet) {
  const startRow = isLegacyQonoqSheet_(sheet) ? legacyDataStartRow_(sheet) : 2;
  ensureColumns_(sheet, 6);
  const maxRows = Math.max(sheet.getMaxRows(), startRow);
  const scanWidth = 6;
  const values = sheet.getRange(startRow, 1, maxRows - startRow + 1, scanWidth).getDisplayValues();
  let lastOrderRow = startRow - 1;

  for (let index = values.length - 1; index >= 0; index -= 1) {
    const row = values[index];
    const hasDate = String(row[0] || "").trim();
    const hasCheckNumber = String(row[3] || "").trim();
    const hasAnyOrderData = row.slice(0, Math.min(row.length, 6)).some((value) => String(value || "").trim());

    if ((hasDate || hasCheckNumber) && hasAnyOrderData) {
      lastOrderRow = startRow + index;
      break;
    }
  }

  let targetRow = Math.max(startRow, lastOrderRow + 1);
  if (targetRow > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), 20);
  }

  if (rowHasFormulas_(sheet, targetRow, scanWidth)) {
    sheet.insertRowBefore(targetRow);
  }

  return targetRow;
}

function rowHasFormulas_(sheet, row, width) {
  if (row > sheet.getMaxRows()) return false;
  return sheet.getRange(row, 1, 1, width).getFormulas()[0].some((formula) => String(formula || "").trim());
}

function firstDataRowAfterContent_(sheet, startRow, columns) {
  const maxRows = Math.max(sheet.getMaxRows(), startRow);
  const minCol = Math.min.apply(null, columns);
  const maxCol = Math.max.apply(null, columns);
  const values = sheet.getRange(startRow, minCol, maxRows - startRow + 1, maxCol - minCol + 1).getDisplayValues();

  for (let index = 0; index < values.length; index += 1) {
    const rowNumber = startRow + index;
    if (isHiddenRow_(sheet, rowNumber)) continue;
    const hasContent = columns.some((column) => String(values[index][column - minCol] || "").trim());
    if (!hasContent) {
      return rowNumber;
    }
  }

  const nextRow = maxRows + 1;
  if (nextRow > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 20);
  return nextRow;
}

function isHiddenRow_(sheet, row) {
  try {
    return sheet.isRowHiddenByUser(row) || sheet.isRowHiddenByFilter(row);
  } catch (error) {
    return false;
  }
}

function hasDuplicate_(sheet, idempotencyKey) {
  if (!idempotencyKey) return false;

  const maxRows = Math.max(sheet.getMaxRows(), 2);
  const candidateColumns = [HEADERS.indexOf("Idempotency Key") + 1, 23].filter((column, index, list) => column > 0 && list.indexOf(column) === index);

  return candidateColumns.some((column) => {
    if (column > sheet.getMaxColumns()) return false;
    const values = sheet.getRange(2, column, maxRows - 1, 1).getDisplayValues();
    return values.some((row) => String(row[0] || "").trim() === idempotencyKey);
  });
}

function buildRow_(payload, idempotencyKey) {
  const action = String(payload.action || "");
  const recipient = payload.recipientName || (action === "INKASSA" ? payload.clientName : "");
  const amount = amountForAction_(payload);

  return [
    payload.createdAt || new Date(),
    actionLabel_(action),
    payload.branchCode || "",
    payload.branchName || payload.branch || "",
    payload.orderNumber || payload.checkNumber || "",
    payload.clientName || fioForAction_(payload),
    payload.phone || "",
    payload.passport || "",
    formatLockers_(payload.lockers),
    payload.checkIn || "",
    payload.checkOut || "",
    amount === null || amount === undefined ? "" : amount,
    payload.currency || "",
    payload.paymentType || "",
    recipient || "",
    payload.note || payload.reason || payload.category || "",
    payload.sheetSection || action || "",
    idempotencyKey || "",
  ];
}

function buildLegacyRow_(payload, idempotencyKey) {
  const action = String(payload.action || "").toUpperCase();
  const currency = String(payload.currency || "UZS").toUpperCase();
  const amountColumn = amountColumnForCurrency_(currency);
  const width = Math.max(amountColumn, 23);
  const row = new Array(width).fill("");

  row[0] = formatSheetDate_(payload.createdAt || new Date());
  row[1] = fioForAction_(payload);
  row[3] = checkLabelForAction_(payload);
  row[5] = periodForAction_(payload);

  const amount = amountForAction_(payload);
  if (amount !== null && amount !== undefined && amount !== "") {
    row[amountColumn - 1] = amount;
  }

  row[22] = idempotencyKey;
  return row;
}

function amountColumnForCurrency_(currency) {
  const columns = {
    UZS: 15,
    USD: 16,
    EUR: 17,
    RUB: 18,
    KZT: 19,
    TJS: 20,
  };
  return columns[currency] || columns.UZS;
}

function amountForAction_(payload) {
  const action = String(payload.action || "").toUpperCase();
  const value = action === "SALARY" ? payload.salaryAmount : payload.amount;
  if (value === null || value === undefined || value === "") return "";
  const number = Math.abs(Number(value || 0));
  if (!Number.isFinite(number)) return value;
  return ["EXPENSE", "SALARY"].includes(action) ? -number : number;
}

function fioForAction_(payload) {
  const action = String(payload.action || "").toUpperCase();
  if (action === "EXPENSE") return "RASXOD";
  if (action === "SALARY") return ["OYLIK", payload.salaryReceiver].filter(Boolean).join(" - ");
  return payload.clientName || payload.recipientName || "";
}

function checkLabelForAction_(payload) {
  const action = String(payload.action || "").toUpperCase();
  if (action === "EXPENSE") return "Xarajat";
  if (action === "SALARY") return "Oylik";
  return payload.orderNumber || payload.checkNumber || "";
}

function periodForAction_(payload) {
  const action = String(payload.action || "").toUpperCase();
  if (action === "EXPENSE") return payload.period || payload.category || payload.reason || "Xarajat";
  if (action === "SALARY") return payload.period || "Oylik";
  return payload.tariffHours || payload.period || "";
}

function isLegacyQonoqSheet_(sheet) {
  const rows = Math.min(sheet.getMaxRows(), 8);
  const cols = Math.min(sheet.getMaxColumns(), 25);
  const text = sheet.getRange(1, 1, rows, cols).getDisplayValues().flat().join(" ").toLowerCase();
  return text.indexOf("наименование") !== -1 || text.indexOf("инкасса") !== -1 || text.indexOf("остаток uzs") !== -1;
}

function legacyDataStartRow_(sheet) {
  const rows = Math.min(sheet.getMaxRows(), 12);
  const values = sheet.getRange(1, 1, rows, Math.min(sheet.getMaxColumns(), 25)).getDisplayValues();
  for (let index = 0; index < values.length; index += 1) {
    const rowText = values[index].join(" ").toLowerCase();
    if (rowText.indexOf("наименование") !== -1 || rowText.indexOf("период хранения") !== -1) {
      return index + 2;
    }
  }
  return 5;
}

function writeLegacyInkassaRow_(sheet, payload, idempotencyKey) {
  const currency = String(payload.currency || "UZS").toUpperCase();
  const amountColumns = (payload.legacySheetTarget && payload.legacySheetTarget.amountColumnByCurrency) || {};
  const amountColumn = Number(amountColumns[currency] || amountColumns.UZS || 15);
  const nameColumn = Number(payload.legacySheetTarget && payload.legacySheetTarget.nameColumn || 22);
  const width = Math.max(nameColumn, amountColumn, 23);
  const startRow = legacyDataStartRow_(sheet);
  const targetRow = firstDataRowAfterContent_(sheet, startRow, [1, 2, 4, 6, 15, 16, 17, 18, 19, 20, 21, 22]);
  const row = new Array(width).fill("");
  ensureColumns_(sheet, width);

  row[0] = formatSheetDate_(payload.createdAt || new Date());
  row[1] = payload.recipientName || payload.clientName || "INKASSA";
  row[amountColumn - 1] = payload.amount === null || payload.amount === undefined ? "" : payload.amount;
  row[nameColumn - 1] = payload.recipientName || payload.clientName || payload.note || "INKASSA";
  row[22] = idempotencyKey;

  sheet.getRange(targetRow, 1, 1, row.length).setValues([row]);
  sheet.getRange(targetRow, 1, 1, row.length).setBackground("#fce4d6").setFontColor("#7f1d1d").setFontWeight("bold");
  return targetRow;
}

function formatSheetDate_(dateValue) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) return dateValue || "";
  return Utilities.formatDate(date, "Asia/Tashkent", "dd.MM.yyyy");
}

function styleRow_(sheet, row, action, width) {
  const style = ACTION_STYLE[String(action || "").toUpperCase()];
  if (!style) return;

  const range = sheet.getRange(row, 1, 1, width);
  range.setBackground(style.background);
  range.setFontColor(style.fontColor);

  if (["EXPENSE", "SALARY"].includes(String(action || "").toUpperCase())) {
    range.setFontWeight("bold");
  }
}

function actionLabel_(action) {
  switch (String(action || "").toUpperCase()) {
    case "INKASSA":
      return "Inkassa";
    case "EXPENSE":
      return "Xarajat";
    case "SALARY":
      return "Oylik";
    case "DEBT_CLOSED":
      return "Qarz yopildi";
    case "NEW_ORDER":
      return "Yangi order";
    case "PICKUP":
      return "Pickup";
    case "SHIFT_OPEN":
      return "Smena ochildi";
    case "SHIFT_CLOSE":
      return "Smena yopildi";
    default:
      return action || "";
  }
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
