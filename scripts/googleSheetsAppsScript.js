/*
 * Google Apps Script webhook for Qonoq Baggage Google Sheets.
 *
 * Deploy:
 * 1. Open the Google Sheet -> Extensions -> Apps Script.
 * 2. Replace the current webhook code with this file contents.
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

const WRITABLE_ACTIONS = new Set(["NEW_ORDER", "DOPLATA", "EXPENSE", "INKASSA", "SALARY"]);
const LEGACY_WIDTH = 22; // A:V
const IDEMPOTENCY_COLUMN = 23; // hidden/helper column W

const COLUMN = {
  DATE: 1,
  FIO: 2,
  PLACE: 3,
  CHECK: 4,
  PERIOD: 5,
  CASH_UZS: 6,
  CASH_USD: 7,
  CASH_EUR: 8,
  CASH_RUB: 9,
  CASH_KZT: 10,
  CASH_TJS: 11,
  CLICK: 12,
  PAYME: 13,
  TERMINAL: 14,
  BALANCE_UZS: 15,
  BALANCE_USD: 16,
  BALANCE_EUR: 17,
  BALANCE_RUB: 18,
  BALANCE_KZT: 19,
  BALANCE_TJS: 20,
  EXPENSE: 21,
  NAME: 22,
};

const CASH_COLUMN_BY_CURRENCY = {
  UZS: COLUMN.CASH_UZS,
  USD: COLUMN.CASH_USD,
  EUR: COLUMN.CASH_EUR,
  RUB: COLUMN.CASH_RUB,
  KZT: COLUMN.CASH_KZT,
  TJS: COLUMN.CASH_TJS,
};

const BALANCE_COLUMN_BY_CURRENCY = {
  UZS: COLUMN.BALANCE_UZS,
  USD: COLUMN.BALANCE_USD,
  EUR: COLUMN.BALANCE_EUR,
  RUB: COLUMN.BALANCE_RUB,
  KZT: COLUMN.BALANCE_KZT,
  TJS: COLUMN.BALANCE_TJS,
};

const FRACTION_DIGITS_BY_CURRENCY = {
  UZS: 0,
  USD: 2,
  EUR: 2,
  RUB: 2,
  KZT: 2,
  TJS: 2,
};

const ACTION_STYLE = {
  DOPLATA: { background: "#d9ead3", fontColor: "#14532d" },
  EXPENSE: { background: "#f4cccc", fontColor: "#7f1d1d" },
  SALARY: { background: "#f4cccc", fontColor: "#7f1d1d" },
  INKASSA: { background: "#fce4d6", fontColor: "#000000" },
};

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const action = String(payload.action || "").toUpperCase();

    if (!WRITABLE_ACTIONS.has(action)) {
      return json_({ ok: true, skipped: true, reason: "Unsupported action: " + action });
    }

    const branchCode = String(payload.branchCode || "").trim();
    const sheetName = SHEET_BY_BRANCH_CODE[branchCode];
    if (!sheetName) throw new Error("Unknown branchCode: " + branchCode);

    const sheet = getOrCreateSheet_(sheetName);
    ensureColumns_(sheet, IDEMPOTENCY_COLUMN);

    const idempotencyKey = String(payload.idempotencyKey || buildIdempotencyKey_(payload));
    if (hasDuplicate_(sheet, idempotencyKey)) {
      return json_({ ok: true, duplicate: true, idempotencyKey });
    }

    const row = buildLegacyRow_(payload);
    const targetRow = findNextOrderRow(sheet);
    // C (№ места / Кол-во место) is a text value such as "1-S 2-M 1-L".
    // Force plain text so an existing custom number format cannot render it as #.
    sheet.getRange(targetRow, COLUMN.PLACE).setNumberFormat("@");
    sheet.getRange(targetRow, 1, 1, LEGACY_WIDTH).setValues([row]);
    sheet.getRange(targetRow, IDEMPOTENCY_COLUMN).setValue(idempotencyKey);
    applyMoneyFormat_(sheet, targetRow, payload);
    styleRow_(sheet, targetRow, action);

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

function ensureColumns_(sheet, minColumns) {
  const currentColumns = sheet.getMaxColumns();
  if (currentColumns < minColumns) {
    sheet.insertColumnsAfter(currentColumns, minColumns - currentColumns);
  }
}

function findNextOrderRow(sheet) {
  const startRow = legacyDataStartRow_(sheet);
  ensureColumns_(sheet, IDEMPOTENCY_COLUMN);

  const maxRows = Math.max(sheet.getMaxRows(), startRow);
  const watchedColumns = [
    COLUMN.DATE,
    COLUMN.FIO,
    COLUMN.CHECK,
    COLUMN.BALANCE_UZS,
    COLUMN.EXPENSE,
  ];
  const minColumn = Math.min.apply(null, watchedColumns);
  const maxColumn = Math.max.apply(null, watchedColumns);
  const values = sheet.getRange(startRow, minColumn, maxRows - startRow + 1, maxColumn - minColumn + 1).getDisplayValues();

  let lastDataRow = startRow - 1;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const row = values[index];
    const hasData = watchedColumns.some((column) => String(row[column - minColumn] || "").trim());
    if (hasData) {
      lastDataRow = startRow + index;
      break;
    }
  }

  let targetRow = Math.max(startRow, lastDataRow + 1);
  if (targetRow > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), 20);
  }
  if (rowHasFormulas_(sheet, targetRow, LEGACY_WIDTH)) {
    sheet.insertRowBefore(targetRow);
  }
  return targetRow;
}

function rowHasFormulas_(sheet, row, width) {
  if (row > sheet.getMaxRows()) return false;
  return sheet.getRange(row, 1, 1, width).getFormulas()[0].some((formula) => String(formula || "").trim());
}

function legacyDataStartRow_(sheet) {
  const rows = Math.min(sheet.getMaxRows(), 12);
  const values = sheet.getRange(1, 1, rows, Math.min(sheet.getMaxColumns(), LEGACY_WIDTH)).getDisplayValues();
  for (let index = 0; index < values.length; index += 1) {
    const text = values[index].join(" ").toLowerCase();
    if (
      text.indexOf("ф.и.о") !== -1 ||
      text.indexOf("период хранения") !== -1 ||
      text.indexOf("наименование") !== -1 ||
      text.indexOf("№ чек") !== -1
    ) {
      return index + 2;
    }
  }
  return 5;
}

function hasDuplicate_(sheet, idempotencyKey) {
  if (!idempotencyKey || IDEMPOTENCY_COLUMN > sheet.getMaxColumns()) return false;
  const maxRows = Math.max(sheet.getMaxRows(), 2);
  const values = sheet.getRange(2, IDEMPOTENCY_COLUMN, maxRows - 1, 1).getDisplayValues();
  return values.some((row) => String(row[0] || "").trim() === idempotencyKey);
}

function buildLegacyRow_(payload) {
  const action = String(payload.action || "").toUpperCase();
  const row = new Array(LEGACY_WIDTH).fill("");

  row[COLUMN.DATE - 1] = formatSheetDate_(payload.createdAt || new Date());

  if (action === "NEW_ORDER") {
    fillNewOrderRow_(row, payload);
  } else if (action === "DOPLATA") {
    fillDoplataRow_(row, payload);
  } else if (action === "EXPENSE") {
    fillExpenseRow_(row, payload);
  } else if (action === "SALARY") {
    fillSalaryRow_(row, payload);
  } else if (action === "INKASSA") {
    fillInkassaRow_(row, payload);
  }

  return row;
}

function fillNewOrderRow_(row, payload) {
  row[COLUMN.FIO - 1] = payload.clientName || payload.fio || "";
  row[COLUMN.PLACE - 1] = formatPlaces_(payload);
  row[COLUMN.CHECK - 1] = payload.orderNumber || payload.checkNumber || "";
  row[COLUMN.PERIOD - 1] = payload.period || payload.tariffHours || payload.storagePeriod || "";

  const amount = sheetAmount_(payload, payload.amount, payload.finalAmount, payload.realPaidAmount, payload.paidAmount);
  if (amount === "") return;

  const paymentType = String(payload.paymentType || "CASH").toUpperCase();
  const currency = String(payload.currency || "UZS").toUpperCase();
  if (paymentType === "CLICK") {
    row[COLUMN.CLICK - 1] = amount;
  } else if (paymentType === "PAYME") {
    row[COLUMN.PAYME - 1] = amount;
  } else if (paymentType === "CARD" || paymentType === "TERMINAL") {
    row[COLUMN.TERMINAL - 1] = amount;
  } else {
    row[(CASH_COLUMN_BY_CURRENCY[currency] || COLUMN.CASH_UZS) - 1] = amount;
  }
}

function fillDoplataRow_(row, payload) {
  row[COLUMN.FIO - 1] = payload.clientName || payload.fio || "";
  row[COLUMN.PLACE - 1] = formatPlaces_(payload);
  row[COLUMN.CHECK - 1] = payload.orderNumber || payload.checkNumber || "";
  row[COLUMN.PERIOD - 1] = payload.period || payload.tariffHours || payload.storagePeriod || "";
  row[COLUMN.NAME - 1] = "DOPLATA";

  const amount = sheetAmount_(payload, payload.amount, payload.overtimeAmount, payload.finalAmount, payload.realPaidAmount);
  if (amount === "") return;

  const paymentType = String(payload.paymentType || "CASH").toUpperCase();
  const currency = String(payload.currency || "UZS").toUpperCase();
  if (paymentType === "CLICK") {
    row[COLUMN.CLICK - 1] = amount;
  } else if (paymentType === "PAYME") {
    row[COLUMN.PAYME - 1] = amount;
  } else if (paymentType === "CARD" || paymentType === "TERMINAL") {
    row[COLUMN.TERMINAL - 1] = amount;
  } else {
    row[(CASH_COLUMN_BY_CURRENCY[currency] || COLUMN.CASH_UZS) - 1] = amount;
  }
}

function fillExpenseRow_(row, payload) {
  clearColumns_(row, COLUMN.CASH_UZS, COLUMN.TERMINAL);
  clearColumns_(row, COLUMN.BALANCE_UZS, COLUMN.BALANCE_TJS);
  const category = payload.category || payload.fio || payload.clientName || "Xarajat";
  const reason = payload.reason || payload.note || "";
  row[COLUMN.FIO - 1] = category;
  row[COLUMN.EXPENSE - 1] = sheetAmount_(payload, payload.expenseAmount, payload.amount, payload.finalAmount, payload.amountUzs);
  row[COLUMN.NAME - 1] = [category, reason].filter(Boolean).join(" - ");
}

function fillSalaryRow_(row, payload) {
  clearColumns_(row, COLUMN.CASH_UZS, COLUMN.TERMINAL);
  clearColumns_(row, COLUMN.BALANCE_UZS, COLUMN.BALANCE_TJS);
  const receiver = payload.salaryReceiver || payload.recipientName || payload.adminName || "";
  row[COLUMN.FIO - 1] = receiver || payload.adminName || "Oylik";
  row[COLUMN.EXPENSE - 1] = sheetAmount_(payload, payload.salaryAmount, payload.amount, payload.finalAmount, payload.amountUzs);
  row[COLUMN.NAME - 1] = ["Oylik", receiver].filter(Boolean).join(" - ");
}

function fillInkassaRow_(row, payload) {
  clearColumns_(row, COLUMN.CASH_UZS, COLUMN.TERMINAL);
  const receiver = payload.receiverName || payload.recipientName || payload.clientName || "";
  const note = payload.note || "";
  const currency = String(payload.currency || "UZS").toUpperCase();
  row[COLUMN.FIO - 1] = receiver;
  row[(BALANCE_COLUMN_BY_CURRENCY[currency] || COLUMN.BALANCE_UZS) - 1] = sheetAmount_(payload, payload.inkassaAmount, payload.amount, payload.finalAmount, payload.amountUzs);
  const cleanNote = String(note).toLowerCase() === "inkassa" ? "" : note;
  row[COLUMN.NAME - 1] = ["Inkassa", currency === "UZS" ? "" : currency, cleanNote].filter(Boolean).join(" - ");
}

function clearColumns_(row, firstColumn, lastColumn) {
  for (let column = firstColumn; column <= lastColumn; column += 1) {
    row[column - 1] = "";
  }
}

function amountAbs_(value, currency) {
  if (value === null || value === undefined || value === "") return "";
  const number = Math.abs(Number(value || 0));
  if (!Number.isFinite(number)) return value;
  const code = String(currency || "UZS").toUpperCase();
  const digits = FRACTION_DIGITS_BY_CURRENCY[code] || 0;
  return digits ? number / Math.pow(10, digits) : number;
}

function sheetAmount_(payload) {
  if (payload.sheetAmount !== null && payload.sheetAmount !== undefined && payload.sheetAmount !== "") {
    const normalized = Math.abs(Number(payload.sheetAmount));
    return Number.isFinite(normalized) ? normalized : payload.sheetAmount;
  }
  const values = Array.prototype.slice.call(arguments, 1);
  return amountAbs_(firstValue_.apply(null, values), payload.currency);
}

function applyMoneyFormat_(sheet, row, payload) {
  const code = String(payload.currency || "UZS").toUpperCase();
  const format = (FRACTION_DIGITS_BY_CURRENCY[code] || 0) > 0 ? "#,##0.00" : "#,##0";
  const action = String(payload.action || "").toUpperCase();
  let column = null;
  if (action === "EXPENSE" || action === "SALARY") column = COLUMN.EXPENSE;
  if (action === "INKASSA") column = BALANCE_COLUMN_BY_CURRENCY[code] || COLUMN.BALANCE_UZS;
  if (action === "NEW_ORDER" || action === "DOPLATA") {
    const paymentType = String(payload.paymentType || "CASH").toUpperCase();
    if (paymentType === "CLICK") column = COLUMN.CLICK;
    else if (paymentType === "PAYME") column = COLUMN.PAYME;
    else if (paymentType === "CARD" || paymentType === "TERMINAL") column = COLUMN.TERMINAL;
    else column = CASH_COLUMN_BY_CURRENCY[code] || COLUMN.CASH_UZS;
  }
  if (column) sheet.getRange(row, column).setNumberFormat(format);
}

function firstValue_() {
  for (let index = 0; index < arguments.length; index += 1) {
    const value = arguments[index];
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return "";
}

function formatPlaces_(payload) {
  const lockers = Array.isArray(payload.lockers) ? payload.lockers : [];
  const counts = lockers.reduce(function (acc, locker) {
    const size = String(locker.size || "").toUpperCase();
    if (!size) return acc;
    acc[size] = (acc[size] || 0) + Number(locker.count || 1);
    return acc;
  }, {});
  const fromCounts = ["S", "M", "L", "XL"]
    .map(function (size) {
      return counts[size] > 0 ? counts[size] + "-" + size : "";
    })
    .filter(Boolean)
    .join(" ");
  if (fromCounts) return fromCounts;

  // Backward-compatible fallback for older payloads; never allow # in column C.
  return String(payload.place || payload.places || "")
    .replace(/#/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatSheetDate_(dateValue) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) return dateValue || "";
  if (typeof Utilities === "undefined") {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Asia/Tashkent",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(date);
  }
  return Utilities.formatDate(date, "Asia/Tashkent", "dd.MM.yyyy");
}

function styleRow_(sheet, row, action) {
  const style = ACTION_STYLE[String(action || "").toUpperCase()];
  if (!style) return;
  const range = sheet.getRange(row, 1, 1, LEGACY_WIDTH);
  range.setBackground(style.background);
  range.setFontColor(style.fontColor);
  range.setFontWeight("bold");
}

function buildIdempotencyKey_(payload) {
  return [payload.action || "UNKNOWN", payload.branchCode || "NO_BRANCH", payload.orderNumber || payload.orderId || payload.entityId || payload.createdAt]
    .filter(Boolean)
    .join(":");
}

function json_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    COLUMN,
    SHEET_BY_BRANCH_CODE,
    buildLegacyRow_,
    formatPlaces_,
    amountAbs_,
    sheetAmount_,
  };
}
