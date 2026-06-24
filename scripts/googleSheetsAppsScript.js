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

const SHEET_NAME_PATTERN_BY_BRANCH_CODE = {
  TIA: /(tia|ташкент.*аэропорт|toshkent.*aeroport)/i,
  TSV: /(tsv|ташкент.*(север|шимол)|toshkent.*shimol)/i,
  TJV: /(tjv|ташкент.*(юж|жануб)|toshkent.*janub)/i,
  SVK: /(svk|самарканд.*вокзал|samarqand.*vokzal)/i,
  SIA: /(sia|самарканд.*аэропорт|samarqand.*aeroport)/i,
};

const WRITABLE_ACTIONS = new Set(["NEW_ORDER", "DOPLATA", "EXPENSE", "INKASSA", "SALARY"]);
const SCRIPT_VERSION = "v3-inkassa-mapping";
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
  CASH_END: 11,
  CLICK: 12,
  PAYME: 13,
  TERMINAL: 14,
  BALANCE_UZS: 15,
  BALANCE_USD: 16,
  BALANCE_EUR: 17,
  BALANCE_RUB: 18,
  BALANCE_KZT: 19,
  BALANCE_TJS: 20,
  BALANCE_END: 20,
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
      return json_({ success: true, ok: true, scriptVersion: SCRIPT_VERSION, skipped: true, reason: "Unsupported action: " + action });
    }

    const branchCode = String(payload.branchCode || "").trim();
    if (!SHEET_BY_BRANCH_CODE[branchCode]) throw new Error("Unknown branchCode: " + branchCode);

    const lock = LockService.getDocumentLock();
    lock.waitLock(30000);
    try {
      const sheet = getOrCreateSheet_(branchCode);
      ensureColumns_(sheet, IDEMPOTENCY_COLUMN);

      const idempotencyKey = String(payload.idempotencyKey || buildIdempotencyKey_(payload));
      if (hasDuplicate_(sheet, idempotencyKey)) {
        return json_({ success: true, ok: true, scriptVersion: SCRIPT_VERSION, duplicate: true, idempotencyKey });
      }

      const row = buildLegacyRow_(payload);
      if (row.length !== LEGACY_WIDTH) throw new Error("Row must contain exactly 22 columns (A:V)");
      console.log("[GoogleSheets] finalRow " + JSON.stringify({ action, branchCode, row }));
      const targetRow = findNextOrderRow(sheet);
      // C contains only grouped size counts; locker numbers and # are never accepted.
      sheet.getRange(targetRow, COLUMN.PLACE).setNumberFormat("@");
      sheet.getRange(targetRow, 1, 1, LEGACY_WIDTH).setValues([row]);
      sheet.getRange(targetRow, IDEMPOTENCY_COLUMN).setValue(idempotencyKey);
      applyMoneyFormat_(sheet, targetRow, payload);
      styleRow_(sheet, targetRow, action);

      return json_({ success: true, ok: true, scriptVersion: SCRIPT_VERSION, row: targetRow, idempotencyKey, finalRow: row });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    console.error(error);
    return json_({ success: false, ok: false, scriptVersion: SCRIPT_VERSION, error: error.message });
  }
}

function getOrCreateSheet_(branchCode) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const exactName = SHEET_BY_BRANCH_CODE[branchCode];
  const exact = spreadsheet.getSheetByName(exactName);
  if (exact) return exact;

  const pattern = SHEET_NAME_PATTERN_BY_BRANCH_CODE[branchCode];
  const existing = pattern
    ? spreadsheet.getSheets().find(function (sheet) { return pattern.test(sheet.getName()); })
    : null;
  return existing || spreadsheet.insertSheet(exactName);
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
      text.indexOf("№ чек") !== -1 ||
      text.indexOf("кол-во место") !== -1
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
  if (action === "NEW_ORDER") return buildNewOrderRow(payload);
  if (action === "DOPLATA") return buildDoplataRow(payload);
  if (action === "EXPENSE") return buildExpenseRow(payload);
  if (action === "SALARY") return buildSalaryRow(payload);
  if (action === "INKASSA") return buildInkassaRow(payload);
  throw new Error("Unsupported action: " + action);
}

function createRow_(payload) {
  const row = new Array(LEGACY_WIDTH).fill("");
  row[COLUMN.DATE - 1] = formatSheetDate_(payload.createdAt || new Date());
  return row;
}

function buildNewOrderRow(payload) {
  const row = createRow_(payload);
  row[COLUMN.FIO - 1] = payload.clientName || payload.fio || "";
  row[COLUMN.PLACE - 1] = formatSizeCounts_(payload);
  row[COLUMN.CHECK - 1] = payload.orderNumber || payload.checkNumber || "";
  row[COLUMN.PERIOD - 1] = payload.period || payload.tariffHours || payload.storagePeriod || "";
  row[COLUMN.NAME - 1] = payload.operationName || "Хранение багажа";

  const amount = sheetAmount_(payload, payload.amount, payload.finalAmount, payload.realPaidAmount, payload.paidAmount);
  if (amount !== "") writeRevenue_(row, payload, amount);
  return row;
}

function writeRevenue_(row, payload, amount) {
  const paymentType = String(payload.paymentType || "CASH").toUpperCase();
  const currency = String(payload.currency || "UZS").toUpperCase();
  if (paymentType === "CLICK") {
    row[COLUMN.CLICK - 1] = amount;
  } else if (paymentType === "PAYME") {
    row[COLUMN.PAYME - 1] = amount;
  } else if (paymentType === "CARD" || paymentType === "TERMINAL") {
    row[COLUMN.TERMINAL - 1] = amount;
  } else if (paymentType === "CASH" || !payload.paymentType) {
    const cashColumn = CASH_COLUMN_BY_CURRENCY[currency];
    if (!cashColumn) throw new Error("Unsupported cash currency: " + currency);
    row[cashColumn - 1] = amount;
  }
}

function buildDoplataRow(payload) {
  const row = createRow_(payload);
  row[COLUMN.FIO - 1] = payload.clientName || payload.fio || "";
  row[COLUMN.PLACE - 1] = formatSizeCounts_(payload);
  row[COLUMN.CHECK - 1] = payload.orderNumber || payload.checkNumber || "";
  row[COLUMN.PERIOD - 1] = payload.doplataPeriod || payload.period || payload.storagePeriod || "DOPLATA";
  row[COLUMN.NAME - 1] = payload.operationName || "Доплата";

  const amount = sheetAmount_(payload, payload.amount, payload.overtimeAmount, payload.finalAmount, payload.realPaidAmount);
  if (amount !== "") writeRevenue_(row, payload, amount);
  return row;
}

function buildExpenseRow(payload) {
  const row = createRow_(payload);
  const category = payload.category || payload.fio || payload.clientName || "Xarajat";
  const reason = payload.reason || payload.note || "";
  row[COLUMN.FIO - 1] = payload.adminName || payload.responsibleName || category;
  row[COLUMN.EXPENSE - 1] = sheetAmount_(payload, payload.expenseAmount, payload.amount, payload.finalAmount, payload.amountUzs);
  row[COLUMN.NAME - 1] = [category, reason].filter(Boolean).join(" - ");
  return row;
}

function buildSalaryRow(payload) {
  const row = createRow_(payload);
  const receiver = payload.salaryReceiver || payload.recipientName || payload.adminName || "";
  row[COLUMN.FIO - 1] = receiver || payload.adminName || "Oylik";
  row[COLUMN.EXPENSE - 1] = sheetAmount_(payload, payload.salaryAmount, payload.amount, payload.finalAmount, payload.amountUzs);
  row[COLUMN.NAME - 1] = ["Oylik", receiver].filter(Boolean).join(" - ");
  return row;
}

function buildInkassaRow(payload) {
  const row = createRow_(payload);
  const receiver = payload.receiverName || payload.recipientName || payload.clientName || "";
  const note = payload.note || "";
  const currency = String(payload.currency || "UZS").toUpperCase();
  const balanceColumn = BALANCE_COLUMN_BY_CURRENCY[currency];
  if (!balanceColumn) throw new Error("Unsupported inkassa currency: " + currency);
  row[COLUMN.FIO - 1] = receiver;
  row[balanceColumn - 1] = sheetAmount_(payload, payload.inkassaAmount, payload.amount, payload.finalAmount, payload.amountUzs);
  const cleanNote = String(note).toLowerCase() === "inkassa" ? "" : note;
  row[COLUMN.NAME - 1] = ["Inkassa", receiver || cleanNote].filter(Boolean).join(" - ");
  return row;
}

function parseNumber_(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  let text = String(value).trim().replace(/[\s\u00a0\u202f]/g, "");
  if (!text) return "";
  if (text.indexOf(",") !== -1 && text.indexOf(".") !== -1) {
    if (text.lastIndexOf(",") > text.lastIndexOf(".")) {
      text = text.replace(/\./g, "").replace(",", ".");
    } else {
      text = text.replace(/,/g, "");
    }
  } else {
    text = text.replace(",", ".");
  }
  const number = Number(text);
  if (!Number.isFinite(number)) throw new Error("Invalid currency amount: " + value);
  return number;
}

function amountAbs_(value, currency, amountUnit) {
  const parsed = parseNumber_(value);
  if (parsed === "") return "";
  const number = Math.abs(parsed);
  const code = String(currency || "UZS").toUpperCase();
  const digits = FRACTION_DIGITS_BY_CURRENCY[code] || 0;
  const explicitUnit = String(amountUnit || "").toUpperCase();
  const looksMajor = explicitUnit === "MAJOR" || (!explicitUnit && String(value).match(/[.,]/));
  return digits && !looksMajor ? number / Math.pow(10, digits) : number;
}

function sheetAmount_(payload) {
  if (payload.sheetAmount !== null && payload.sheetAmount !== undefined && payload.sheetAmount !== "") {
    return amountAbs_(payload.sheetAmount, payload.currency, "MAJOR");
  }
  const values = Array.prototype.slice.call(arguments, 1);
  return amountAbs_(firstValue_.apply(null, values), payload.currency, payload.amountUnit);
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

function buildSizeCounts_(payload) {
  const sizes = ["S", "M", "L", "XL"];
  const counts = { S: 0, M: 0, L: 0, XL: 0 };
  const hasSizeCounts = payload.sizeCounts && typeof payload.sizeCounts === "object" && !Array.isArray(payload.sizeCounts);

  if (hasSizeCounts) {
    sizes.forEach(function (size) {
      const count = Number(payload.sizeCounts[size] || 0);
      counts[size] = Number.isFinite(count) && count > 0 ? count : 0;
    });
    return counts;
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  items.forEach(function (item) {
    const size = String((item && (item.size || (item.locker && item.locker.size))) || "").toUpperCase();
    if (sizes.indexOf(size) === -1) return;
    const count = Number(item.count || 1);
    counts[size] += Number.isFinite(count) && count > 0 ? count : 1;
  });
  return counts;
}

function formatSizeCounts_(payload) {
  const counts = buildSizeCounts_(payload);
  return ["S", "M", "L", "XL"]
    .map(function (size) {
      return counts[size] > 0 ? counts[size] + "-" + size : "";
    })
    .filter(Boolean)
    .join(" ");
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
    SCRIPT_VERSION,
    SHEET_BY_BRANCH_CODE,
    buildLegacyRow_,
    buildNewOrderRow,
    buildDoplataRow,
    buildExpenseRow,
    buildSalaryRow,
    buildInkassaRow,
    buildSizeCounts_,
    formatSizeCounts_,
    amountAbs_,
    parseNumber_,
    sheetAmount_,
  };
}
