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
  TIA: "Автоматическая Камера хранения Ташкент Аэропорт 🛅",
  TSV: "Камера хранения Северный вокзал 🛅",
  TJV: "Камера хранения Южный вокзал 🛅",
  SVK: "Камера хранения Самарканд вокзал 🛅",
  SIA: "Автоматическая Камера хранения Самарканд Аэропорт 🛅",
};

// Every branch must resolve to an explicit spreadsheet ID. Additional branch
// IDs can be configured as Apps Script properties: SPREADSHEET_ID_TIA, etc.
const SHEETS = {
  TIA: "1-RSJgecVrUUGzWK6XYpgK6J0pU0fuT5jckbXoiFCoD8",
  TSV: "1SVo_flWiAntj2dCMBh60rMYVnIr8oU6pq6fpp90hvr8",
  TJV: "10-h62nZAEp-puvFF_MurFu1UE0Xdjdx5Qtlv3Qpd0L8",
  SVK: "1Kjr8XWvkVqI2fFpaakMFCvRHI-T-cVX4W6YpDPPF444",
  SIA: "1VwtK7HcKA58o8X7Ttdn9fNvm88oea4TKDuSAPBquvBI",
};

const SHEET_NAME_PATTERN_BY_BRANCH_CODE = {
  TIA: /(tia|ташкент.*аэропорт|toshkent.*aeroport)/i,
  TSV: /(tsv|ташкент.*(север|шимол)|toshkent.*shimol)/i,
  TJV: /(tjv|ташкент.*(юж|жануб)|toshkent.*janub)/i,
  SVK: /(svk|самарканд.*вокзал|samarqand.*vokzal)/i,
  SIA: /(sia|самарканд.*аэропорт|samarqand.*aeroport)/i,
};

const WRITABLE_ACTIONS = new Set(["NEW_ORDER", "DOPLATA", "DEBT_PAYMENT", "CANCEL_ORDER", "EXPENSE", "INKASSA", "SALARY"]);
const MONTH_CHECK_ACTIONS = new Set(["CHECK_MONTH_SHEET"]);
const SCRIPT_VERSION = "v7-dynamic-month-sheet-2026-07-01";
const TASHKENT_OFFSET_MINUTES = 5 * 60;
const LEGACY_WIDTH = 22; // A:V
const LEGACY_TECHNICAL_COLUMN = 23; // W; cleaned once and never written again

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
const MONEY_NUMBER_FORMAT = "#,##0.00";

const ACTION_STYLE = {
  DOPLATA: { background: "#d9ead3", fontColor: "#14532d" },
  DEBT_PAYMENT: { background: "#d9ead3", fontColor: "#14532d" },
  CANCEL_ORDER: { background: "#f4cccc", fontColor: "#7f1d1d" },
  EXPENSE: { background: "#f4cccc", fontColor: "#7f1d1d" },
  SALARY: { background: "#f4cccc", fontColor: "#7f1d1d" },
  INKASSA: { background: "#fce4d6", fontColor: "#000000" },
};

function doPost(e) {
  let branchCode = "";
  let spreadsheet = null;
  let sheet = null;
  let monthSheetName = null;
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const action = String(payload.action || "").toUpperCase();

    if (!WRITABLE_ACTIONS.has(action) && !MONTH_CHECK_ACTIONS.has(action)) {
      return json_({ success: true, ok: true, scriptVersion: SCRIPT_VERSION, skipped: true, reason: "Unsupported action: " + action });
    }

    branchCode = normalizeBranchCode_(payload.branchCode || payload.branchName || payload.branch);
    if (!SHEET_BY_BRANCH_CODE[branchCode]) throw new Error("Unknown branchCode: " + branchCode);
    monthSheetName = monthSheetNameForPayload_(payload);

    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      spreadsheet = getSpreadsheet_(branchCode);
      sheet = getTargetSheet_(spreadsheet, branchCode, payload);
      console.log("[GoogleSheets] spreadsheetOpened " + JSON.stringify({
        branchCode,
        spreadsheetId: spreadsheet.getId(),
        spreadsheetName: spreadsheet.getName(),
        sheetName: sheet.getName(),
        sheetId: sheet.getSheetId(),
        monthSheetName,
      }));
      if (MONTH_CHECK_ACTIONS.has(action)) {
        return json_({
          success: true,
          ok: true,
          checked: true,
          scriptVersion: SCRIPT_VERSION,
          branchCode,
          spreadsheetId: spreadsheet.getId(),
          spreadsheetName: spreadsheet.getName(),
          sheetName: sheet.getName(),
          sheetId: sheet.getSheetId(),
          monthSheetName,
          status: "Month sheet found",
        });
      }
      cleanupLegacyTechnicalColumn_(spreadsheet, sheet);
      ensureColumns_(sheet, LEGACY_WIDTH);

      const idempotencyKey = String(payload.idempotencyKey || buildIdempotencyKey_(payload));
      const duplicateRow = getCachedDeliveryRow_(idempotencyKey);
      if (duplicateRow) {
        return json_({
          success: true,
          ok: true,
          scriptVersion: SCRIPT_VERSION,
          branchCode,
          spreadsheetId: spreadsheet.getId(),
          spreadsheetName: spreadsheet.getName(),
          sheetName: sheet.getName(),
          sheetId: sheet.getSheetId(),
          monthSheetName,
          row: duplicateRow,
          duplicate: true,
        });
      }

      const row = buildLegacyRow_(payload);
      if (row.length !== LEGACY_WIDTH) throw new Error("Row must contain exactly 22 columns (A:V)");
      console.log("[GoogleSheets] finalRow " + JSON.stringify({ action, branchCode, row }));
      const targetRow = findNextOrderRow(sheet);
      // C contains only grouped size counts; locker numbers and # are never accepted.
      sheet.getRange(targetRow, COLUMN.PLACE).setNumberFormat("@");
      sheet.getRange(targetRow, 1, 1, LEGACY_WIDTH).setValues([row]);
      applyMoneyFormat_(sheet, targetRow, payload);
      styleRow_(sheet, targetRow, action);
      verifyWrittenRow_(sheet, targetRow, row);
      cacheDeliveryRow_(idempotencyKey, targetRow);

      if (spreadsheet.getId() !== SHEETS.TJV && branchCode === "TJV") {
        throw new Error("TJV write reached the wrong spreadsheet: " + spreadsheet.getId());
      }

      return json_({
        success: true,
        ok: true,
        scriptVersion: SCRIPT_VERSION,
        branchCode,
        spreadsheetId: spreadsheet.getId(),
        spreadsheetName: spreadsheet.getName(),
        sheetName: sheet.getName(),
        sheetId: sheet.getSheetId(),
        monthSheetName,
        row: targetRow,
        finalRow: row,
      });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    console.error(error);
    return json_({
      success: false,
      ok: false,
      scriptVersion: SCRIPT_VERSION,
      branchCode,
      spreadsheetId: spreadsheet ? spreadsheet.getId() : null,
      spreadsheetName: spreadsheet ? spreadsheet.getName() : null,
      sheetName: sheet ? sheet.getName() : null,
      sheetId: sheet ? sheet.getSheetId() : null,
      monthSheetName: monthSheetName || error.monthSheetName || null,
      status: error.status || null,
      availableSheets: error.availableSheets || null,
      error: error.message,
    });
  }
}

function normalizeBranchCode_(value) {
  const raw = String(value || "").trim();
  const upper = raw.toUpperCase();
  if (SHEET_BY_BRANCH_CODE[upper]) return upper;
  const normalized = raw.toLowerCase().replace(/🛅/g, "").replace(/\s+/g, " ").trim();
  if (upper === "TJW") return "TJV";
  if (
    normalized === "toshkent janubiy" ||
    normalized === "toshkent janubiy vokzal" ||
    normalized === "тошкент жанубий вокзал" ||
    normalized === "камера хранения южный вокзал" ||
    normalized === "южный"
  ) return "TJV";
  return upper;
}

function getSpreadsheet_(branchCode) {
  const propertyKey = "SPREADSHEET_ID_" + branchCode;
  const propertyId = typeof PropertiesService !== "undefined"
    ? PropertiesService.getScriptProperties().getProperty(propertyKey)
    : null;
  const spreadsheetId = SHEETS[branchCode] || propertyId || discoverSpreadsheetId_(branchCode);
  if (!spreadsheetId) {
    throw new Error("Spreadsheet ID is not configured for " + branchCode + ". Set " + propertyKey + " in Apps Script properties.");
  }
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  if (!spreadsheet || spreadsheet.getId() !== spreadsheetId) {
    throw new Error("Failed to open configured spreadsheet for " + branchCode);
  }
  return spreadsheet;
}

function discoverSpreadsheetId_(branchCode) {
  const expectedName = SHEET_BY_BRANCH_CODE[branchCode];
  if (!expectedName || typeof DriveApp === "undefined") return null;

  const files = DriveApp.getFilesByName(expectedName);
  const ids = [];
  while (files.hasNext()) {
    const file = files.next();
    if (file.getMimeType() === MimeType.GOOGLE_SHEETS) ids.push(file.getId());
  }
  if (ids.length > 1) {
    throw new Error(
      "Multiple spreadsheets named '" + expectedName + "' are accessible for " + branchCode +
      ". Set SPREADSHEET_ID_" + branchCode + " explicitly. Matches: " + ids.join(", "),
    );
  }
  if (ids.length === 0) return null;
  console.log("[GoogleSheets] spreadsheetDiscovered " + JSON.stringify({
    branchCode,
    spreadsheetId: ids[0],
    spreadsheetName: expectedName,
  }));
  return ids[0];
}

const MONTH_SHEET_NAMES_RU = [
  "\u042f\u043d\u0432\u0430\u0440\u044c",
  "\u0424\u0435\u0432\u0440\u0430\u043b\u044c",
  "\u041c\u0430\u0440\u0442",
  "\u0410\u043f\u0440\u0435\u043b\u044c",
  "\u041c\u0430\u0439",
  "\u0418\u044e\u043d\u044c",
  "\u0418\u044e\u043b\u044c",
  "\u0410\u0432\u0433\u0443\u0441\u0442",
  "\u0421\u0435\u043d\u0442\u044f\u0431\u0440\u044c",
  "\u041e\u043a\u0442\u044f\u0431\u0440\u044c",
  "\u041d\u043e\u044f\u0431\u0440\u044c",
  "\u0414\u0435\u043a\u0430\u0431\u0440\u044c",
];

function normalizeSheetTitle_(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeHeader_(value) {
  return normalizeSheetTitle_(value).replace(/[.№:#()_\-]/g, "").replace(/\s+/g, " ").trim();
}

function tashkentYearMonth_(dateValue) {
  const parsed = dateValue instanceof Date ? dateValue : new Date(dateValue || Date.now());
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const shifted = new Date(date.getTime() + TASHKENT_OFFSET_MINUTES * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    monthIndex: shifted.getUTCMonth(),
  };
}

function monthSheetNameForDate_(dateValue) {
  const parts = tashkentYearMonth_(dateValue);
  return MONTH_SHEET_NAMES_RU[parts.monthIndex] + " " + parts.year;
}

function monthSheetNameForPayload_(payload) {
  return monthSheetNameForDate_((payload && (payload.createdAt || payload.date)) || new Date());
}

function headerStructureScore_(sheet) {
  const rowCount = Math.max(1, Math.min(12, sheet.getMaxRows()));
  const values = sheet.getRange(1, 1, rowCount, COLUMN.EXPENSE).getDisplayValues();
  const expected = [
    { column: COLUMN.DATE, value: "\u0434\u0430\u0442\u0430" },
    { column: COLUMN.FIO, value: "\u0444\u0438\u043e" },
    { column: COLUMN.CASH_UZS, value: "\u0432 \u043a\u0430\u0441\u0441\u0443" },
    { column: COLUMN.EXPENSE, value: "\u0440\u0430\u0441\u0445\u043e\u0434" },
  ];
  return expected.reduce(function (score, item) {
    const found = values.some(function (row) {
      const header = normalizeHeader_(row[item.column - 1]);
      return header === item.value || header.indexOf(item.value) !== -1;
    });
    return score + (found ? 1 : 0);
  }, 0);
}

function rankMonthSheets_(sheets) {
  return sheets.map(function (sheet) {
    return {
      sheet,
      headerScore: headerStructureScore_(sheet),
      lastRow: sheet.getLastRow(),
      maxRows: sheet.getMaxRows(),
      sheetId: sheet.getSheetId(),
    };
  }).sort(function (left, right) {
    return right.headerScore - left.headerScore ||
      right.lastRow - left.lastRow ||
      right.maxRows - left.maxRows ||
      left.sheetId - right.sheetId;
  });
}

function findMonthSheet_(spreadsheet, payload) {
  const expectedName = monthSheetNameForPayload_(payload || {});
  if (typeof spreadsheet.getSheetByName === "function") {
    const sheet = spreadsheet.getSheetByName(expectedName);
    if (sheet) return sheet;
  }

  return spreadsheet.getSheets().find(function (candidate) {
    return normalizeSheetTitle_(candidate.getName()) === normalizeSheetTitle_(expectedName);
  }) || null;
}

function buildMonthSheetMissingError_(spreadsheet, branchCode, expectedName) {
  const availableSheets = spreadsheet.getSheets().map(function (candidate) { return candidate.getName(); });
  const error = new Error("Month sheet not found: " + expectedName);
  error.status = "Month sheet not found";
  error.branchCode = branchCode;
  error.spreadsheetId = spreadsheet.getId();
  error.spreadsheetName = spreadsheet.getName();
  error.monthSheetName = expectedName;
  error.availableSheets = availableSheets;
  console.error("[GoogleSheets] monthSheetMissing " + JSON.stringify({
    branchCode,
    spreadsheetId: error.spreadsheetId,
    spreadsheetName: error.spreadsheetName,
    monthSheetName: expectedName,
    status: error.status,
    availableSheets,
  }));
  return error;
}

function getTargetSheet_(spreadsheet, branchCode, payload) {
  // All operational rows belong to the current month tab. Never fall back to
  // branch dashboards or create a new tab: a missing month tab is an error.
  const expectedName = monthSheetNameForPayload_(payload || {});
  const monthSheet = findMonthSheet_(spreadsheet, payload || {});
  if (monthSheet) return monthSheet;

  throw buildMonthSheetMissingError_(spreadsheet, branchCode, expectedName);
}

function ensureColumns_(sheet, minColumns) {
  const currentColumns = sheet.getMaxColumns();
  if (currentColumns < minColumns) {
    sheet.insertColumnsAfter(currentColumns, minColumns - currentColumns);
  }
}

function cleanupLegacyTechnicalColumn_(spreadsheet, sheet) {
  if (sheet.getMaxColumns() < LEGACY_TECHNICAL_COLUMN) return;
  const propertyKey = "GS_W_CLEANED_" + spreadsheet.getId() + "_" + sheet.getSheetId();
  const properties = typeof PropertiesService !== "undefined"
    ? PropertiesService.getScriptProperties()
    : null;
  if (properties && properties.getProperty(propertyKey) === "1") return;

  sheet.getRange(1, LEGACY_TECHNICAL_COLUMN, sheet.getMaxRows(), 1).clearContent();
  if (properties) properties.setProperty(propertyKey, "1");
  console.log("[GoogleSheets] legacyTechnicalColumnCleared " + JSON.stringify({
    spreadsheetId: spreadsheet.getId(),
    sheetName: sheet.getName(),
    sheetId: sheet.getSheetId(),
    column: "W",
  }));
}

function idempotencyCacheKey_(value) {
  const text = String(value || "");
  if (typeof Utilities === "undefined") return "gs:" + text.slice(-200);
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    text,
    Utilities.Charset.UTF_8,
  );
  return "gs:" + digest.map(function (byte) {
    return ((byte + 256) % 256).toString(16).padStart(2, "0");
  }).join("");
}

function getCachedDeliveryRow_(idempotencyKey) {
  if (!idempotencyKey || typeof CacheService === "undefined") return null;
  const value = CacheService.getScriptCache().get(idempotencyCacheKey_(idempotencyKey));
  const row = Number(value);
  return Number.isInteger(row) && row > 0 ? row : null;
}

function cacheDeliveryRow_(idempotencyKey, row) {
  if (!idempotencyKey || typeof CacheService === "undefined") return;
  CacheService.getScriptCache().put(idempotencyCacheKey_(idempotencyKey), String(row), 21600);
}

function verifyWrittenRow_(sheet, targetRow, expectedRow) {
  SpreadsheetApp.flush();
  const actualRow = sheet.getRange(targetRow, 1, 1, LEGACY_WIDTH).getValues()[0];

  for (let index = 0; index < expectedRow.length; index += 1) {
    const expected = expectedRow[index];
    const actual = actualRow[index];
    if (index === COLUMN.DATE - 1) {
      if (formatSheetDate_(actual) !== String(expected)) {
        throw new Error("Google Sheets write verification failed in column A at row " + targetRow);
      }
    } else if (typeof expected === "number") {
      if (Number(actual) !== expected) {
        throw new Error("Google Sheets write verification failed in column " + (index + 1) + " at row " + targetRow);
      }
    } else if (String(actual || "") !== String(expected || "")) {
      throw new Error("Google Sheets write verification failed in column " + (index + 1) + " at row " + targetRow);
    }
  }
}

function findNextOrderRow(sheet) {
  const startRow = legacyDataStartRow_(sheet);
  ensureColumns_(sheet, LEGACY_WIDTH);

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

function buildLegacyRow_(payload) {
  const action = String(payload.action || "").toUpperCase();
  if (action === "NEW_ORDER") return buildNewOrderRow(payload);
  if (action === "DOPLATA") return buildDoplataRow(payload);
  if (action === "DEBT_PAYMENT") return buildDebtPaymentRow(payload);
  if (action === "CANCEL_ORDER") return buildCancelOrderRow(payload);
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
  if (!payload.paymentType) throw new Error("paymentType is required for revenue write");
  const paymentType = String(payload.paymentType).toUpperCase();
  const currency = String(payload.currency || "UZS").toUpperCase();
  if (paymentType === "CLICK") {
    row[COLUMN.CLICK - 1] = amount;
  } else if (paymentType === "PAYME") {
    row[COLUMN.PAYME - 1] = amount;
  } else if (paymentType === "CARD" || paymentType === "TERMINAL" || paymentType === "TRANSFER") {
    row[COLUMN.TERMINAL - 1] = amount;
  } else if (paymentType === "CASH") {
    const cashColumn = CASH_COLUMN_BY_CURRENCY[currency];
    if (!cashColumn) throw new Error("Unsupported cash currency: " + currency);
    row[cashColumn - 1] = amount;
  } else {
    throw new Error("Unsupported paymentType for revenue write: " + paymentType);
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

function buildDebtPaymentRow(payload) {
  const row = createRow_(payload);
  row[COLUMN.FIO - 1] = payload.clientName || payload.fio || "";
  row[COLUMN.PLACE - 1] = formatSizeCounts_(payload);
  row[COLUMN.CHECK - 1] = payload.orderNumber || payload.checkNumber || "";
  row[COLUMN.PERIOD - 1] = payload.period || payload.storagePeriod || "QARZ";
  row[COLUMN.NAME - 1] = payload.operationName || "Qarz to'lovi";

  const amount = sheetAmount_(payload, payload.paidAmount, payload.amount, payload.finalAmount, payload.realPaidAmount);
  if (amount !== "") writeRevenue_(row, payload, amount);
  return row;
}

function buildCancelOrderRow(payload) {
  const row = createRow_(payload);
  row[COLUMN.FIO - 1] = payload.clientName || payload.fio || "";
  row[COLUMN.PLACE - 1] = formatSizeCounts_(payload);
  row[COLUMN.CHECK - 1] = payload.orderNumber || payload.checkNumber || "";
  row[COLUMN.PERIOD - 1] = payload.period || payload.storagePeriod || "CANCEL";
  row[COLUMN.NAME - 1] = payload.operationName || "Buyurtma bekor qilindi";

  const amount = sheetAmountSigned_(payload, payload.amount, payload.finalAmount, payload.realPaidAmount, payload.paidAmount);
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

function sheetAmountSigned_(payload) {
  const value = payload.sheetAmount !== null && payload.sheetAmount !== undefined && payload.sheetAmount !== ""
    ? payload.sheetAmount
    : firstValue_.apply(null, Array.prototype.slice.call(arguments, 1));
  const parsed = amountAbs_(value, payload.currency, payload.amountUnit);
  if (parsed === "") return "";
  const numeric = parseNumber_(value);
  return numeric < 0 ? -parsed : parsed;
}

function applyMoneyFormat_(sheet, row, payload) {
  const code = String(payload.currency || "UZS").toUpperCase();
  const format = moneyNumberFormat_();
  const action = String(payload.action || "").toUpperCase();
  let column = null;
  if (action === "EXPENSE" || action === "SALARY") column = COLUMN.EXPENSE;
  if (action === "INKASSA") column = BALANCE_COLUMN_BY_CURRENCY[code] || COLUMN.BALANCE_UZS;
  if (action === "NEW_ORDER" || action === "DOPLATA" || action === "DEBT_PAYMENT" || action === "CANCEL_ORDER") {
    if (!payload.paymentType) throw new Error("paymentType is required for revenue format");
    const paymentType = String(payload.paymentType).toUpperCase();
    if (paymentType === "CLICK") column = COLUMN.CLICK;
    else if (paymentType === "PAYME") column = COLUMN.PAYME;
    else if (paymentType === "CARD" || paymentType === "TERMINAL" || paymentType === "TRANSFER") column = COLUMN.TERMINAL;
    else column = CASH_COLUMN_BY_CURRENCY[code] || COLUMN.CASH_UZS;
  }
  if (column) sheet.getRange(row, column).setNumberFormat(format);
}

function moneyNumberFormat_() {
  return MONEY_NUMBER_FORMAT;
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
    SHEETS,
    SHEET_BY_BRANCH_CODE,
    MONTH_CHECK_ACTIONS,
    normalizeBranchCode_,
    getTargetSheet_,
    findMonthSheet_,
    headerStructureScore_,
    rankMonthSheets_,
    tashkentYearMonth_,
    monthSheetNameForDate_,
    monthSheetNameForPayload_,
    moneyNumberFormat_,
    buildLegacyRow_,
    buildNewOrderRow,
    buildDoplataRow,
    buildDebtPaymentRow,
    buildCancelOrderRow,
    buildExpenseRow,
    buildSalaryRow,
    buildInkassaRow,
    buildSizeCounts_,
    formatSizeCounts_,
    amountAbs_,
    parseNumber_,
    sheetAmount_,
    sheetAmountSigned_,
  };
}
