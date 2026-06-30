const logger = require("../utils/logger");
const prisma = require("../config/prisma");
const { formatTashkentIso } = require("../utils/date");
const { formatAdminName } = require("../utils/displayName");
const { normalizeCurrencyAmount } = require("../utils/money");
const sheetMapper = require("../../scripts/googleSheetsAppsScript");

const TIMEOUT_MS = Number(process.env.GOOGLE_SHEETS_TIMEOUT_MS || 15000);
const EXPECTED_SCRIPT_VERSION = sheetMapper.SCRIPT_VERSION;
const EXPECTED_SPREADSHEET_ID_BY_BRANCH_CODE = {
  TIA: "1-RSJgecVrUUGzWK6XYpgK6J0pU0fuT5jckbXoiFCoD8",
  TSV: "1SVo_flWiAntj2dCMBh60rMYVnIr8oU6pq6fpp90hvr8",
  TJV: "10-h62nZAEp-puvFF_MurFu1UE0Xdjdx5Qtlv3Qpd0L8",
  SVK: "1Kjr8XWvkVqI2fFpaakMFCvRHI-T-cVX4W6YpDPPF444",
  SIA: "1VwtK7HcKA58o8X7Ttdn9fNvm88oea4TKDuSAPBquvBI",
};

const branchNameByCode = {
  TIA: "Toshkent aeroport",
  TSV: "Toshkent Shimoliy vokzal",
  TJV: "Toshkent Janubiy vokzal",
  SVK: "Samarqand vokzal",
  SIA: "Samarqand aeroport",
};
const allowedBranchCodes = new Set(Object.keys(branchNameByCode));

const normalizeBranchCode = (value) => {
  const raw = String(value || "").trim();
  const upper = raw.toUpperCase();
  if (allowedBranchCodes.has(upper)) return upper;

  const normalized = raw
    .toLowerCase()
    .replace(/🛅/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (upper === "TJW") return "TJV";
  if (
    normalized === "toshkent janubiy" ||
    normalized === "toshkent janubiy vokzal" ||
    normalized === "тошкент жанубий вокзал" ||
    normalized === "камера хранения южный вокзал" ||
    normalized === "южный"
  ) return "TJV";
  return upper || null;
};

const enabledValue = () => process.env.GOOGLE_SHEETS_ENABLED || process.env.GOOGLE_SHEET_ENABLED || "";
const getWebhookUrl = () => String(process.env.GOOGLE_SHEET_WEBHOOK || process.env.GOOGLE_SHEETS_WEBHOOK || "").trim();
const maskWebhookUrl = (value = getWebhookUrl()) => {
  const url = String(value || "");
  if (!url) return null;
  const visible = url.slice(-20);
  return `${"*".repeat(Math.max(0, url.length - visible.length))}${visible}`;
};
const summarizeWebhookBody = (body) => String(body || "")
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 500);
const webhookError = (message, { status = null, body = null, json = null } = {}) => {
  const error = new Error(message);
  error.webhookStatus = status;
  error.webhookBody = body;
  error.webhookJson = json;
  return error;
};
const isEnabled = () => ["true", "1", "yes", "on"].includes(String(enabledValue()).toLowerCase()) && Boolean(getWebhookUrl());
const DELIVERABLE_ACTIONS = new Set(["NEW_ORDER", "DOPLATA", "DEBT_PAYMENT", "CANCEL_ORDER", "EXPENSE", "INKASSA", "SALARY"]);
const shouldDeliver = (payload) => DELIVERABLE_ACTIONS.has(String(payload?.action || "").toUpperCase());

const toIso = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : formatTashkentIso(date);
};

const branchCode = (entity) => normalizeBranchCode(
  entity?.branch?.code ||
  entity?.branchCode ||
  entity?.branchName ||
  entity?.branch?.name ||
  (typeof entity?.branch === "string" ? entity.branch : null),
);

const branchName = (entity) => {
  const code = branchCode(entity);
  return branchNameByCode[code] || entity?.branchName || entity?.branch?.name || entity?.branch || null;
};

const adminNameFor = (entity, relationName = "createdBy") => formatAdminName(
  entity?.[relationName] || { name: entity?.adminName, login: entity?.adminLogin },
  { branch: entity?.branch || entity?.branchName || branchName(entity), fallback: null },
);

const validateBranchCode = (payload) => {
  const normalized = normalizeBranchCode(payload.branchCode || payload.branchName || payload.branch);
  payload.branchCode = normalized;
  if (!normalized) {
    throw new Error(`Google Sheets payload is missing branchCode for ${payload.action || "UNKNOWN"}`);
  }
  if (!allowedBranchCodes.has(normalized)) {
    throw new Error(`Unknown Google Sheets branchCode: ${normalized}`);
  }
};

const payloadEntityId = (payload) =>
  payload.orderNumber || payload.orderId || payload.entityId || [payload.action, payload.branchCode, payload.createdAt].filter(Boolean).join(":");

const withDeliveryMetadata = (payload) => ({
  rowPolicy: "FIRST_EMPTY_ROW",
  idempotencyKey: [payload.action || "UNKNOWN", payload.branchCode || "NO_BRANCH", payloadEntityId(payload)].filter(Boolean).join(":"),
  ...payload,
  monthSheetName: sheetMapper.monthSheetNameForPayload_(payload),
});

const deliveryLogMeta = (payload, extra = {}) => ({
  action: payload?.action,
  branchCode: payload?.branchCode,
  branchName: payload?.branchName || payload?.branch || branchNameByCode[payload?.branchCode] || null,
  webhookUrlMasked: maskWebhookUrl(),
  amount: payload?.amount ?? payload?.salaryAmount ?? payload?.finalAmount ?? null,
  currency: payload?.currency || null,
  monthSheetName: payload?.monthSheetName || sheetMapper.monthSheetNameForPayload_(payload || {}),
  orderNumber: payload?.orderNumber || null,
  ...extra,
});

const INKASSA_COLUMN_INDEX_BY_CURRENCY = {
  UZS: 14,
  USD: 15,
  EUR: 16,
  RUB: 17,
  KZT: 18,
  TJS: 19,
};

const validateWebhookResult = (payload, json, expectedRow = sheetMapper.buildLegacyRow_(payload)) => {
  const scriptVersion = json?.scriptVersion || null;
  if (scriptVersion !== EXPECTED_SCRIPT_VERSION) {
    throw new Error(`Google Sheets script version mismatch: expected ${EXPECTED_SCRIPT_VERSION}, received ${scriptVersion || "missing"}`);
  }
  if (json?.branchCode !== payload?.branchCode) {
    throw new Error(`Google Sheets branch mismatch: expected ${payload?.branchCode}, received ${json?.branchCode || "missing"}`);
  }
  const expectedSpreadsheetId = EXPECTED_SPREADSHEET_ID_BY_BRANCH_CODE[payload?.branchCode];
  if (expectedSpreadsheetId && json?.spreadsheetId !== expectedSpreadsheetId) {
    throw new Error(`Google Sheets spreadsheet mismatch for ${payload.branchCode}: expected ${expectedSpreadsheetId}, received ${json?.spreadsheetId || "missing"}`);
  }
  if (!json?.spreadsheetName || !json?.sheetName) {
    throw new Error("Google Sheets response is missing spreadsheetName or sheetName");
  }
  const expectedMonthSheetName = payload?.monthSheetName || sheetMapper.monthSheetNameForPayload_(payload || {});
  if (json?.monthSheetName !== expectedMonthSheetName) {
    throw new Error(`Google Sheets month sheet mismatch: expected ${expectedMonthSheetName}, received ${json?.monthSheetName || "missing"}`);
  }
  if (json?.sheetName !== expectedMonthSheetName) {
    throw new Error(`Google Sheets wrote to wrong sheet: expected ${expectedMonthSheetName}, received ${json?.sheetName || "missing"}`);
  }
  const row = Array.isArray(json?.finalRow) ? json.finalRow : expectedRow;
  if (!Array.isArray(row) || row.length !== 22) {
    throw new Error("Google Sheets response is missing a 22-column finalRow");
  }
  if (json?.duplicate !== true && !Number.isInteger(json?.row)) {
    throw new Error("Google Sheets response is missing the written row number");
  }

  if (String(payload?.action || "").toUpperCase() === "INKASSA") {
    const currency = String(payload.currency || "UZS").toUpperCase();
    const amountIndex = INKASSA_COLUMN_INDEX_BY_CURRENCY[currency];
    if (amountIndex === undefined) throw new Error(`Unsupported inkassa currency: ${currency}`);

    const expectedAmount = Number(payload.sheetAmount ?? payload.inkassaAmount ?? payload.amount);
    const actualAmount = Number(row[amountIndex]);
    if (!Number.isFinite(expectedAmount) || actualAmount !== expectedAmount) {
      throw new Error(`Google Sheets INKASSA amount mismatch: expected ${expectedAmount}, received ${row[amountIndex]}`);
    }
    const receiver = payload.receiverName || payload.recipientName || payload.clientName || "";
    if (row[1] !== receiver) {
      throw new Error(`Google Sheets INKASSA receiver mismatch: expected ${receiver}, received ${row[1]}`);
    }
    if (row[21] !== ["Inkassa", receiver || payload.note].filter(Boolean).join(" - ")) {
      throw new Error(`Google Sheets INKASSA label mismatch: ${row[21]}`);
    }
    if (row.slice(5, 14).some((value) => value !== "" && value !== null && value !== undefined)) {
      throw new Error("Google Sheets INKASSA must not write to revenue columns F:N");
    }
    if (row.slice(14, 20).some((value, index) => index + 14 !== amountIndex && value !== "" && value !== null && value !== undefined)) {
      throw new Error("Google Sheets INKASSA must write to exactly one currency column O:T");
    }
    if (row[20] !== "" && row[20] !== null && row[20] !== undefined) {
      throw new Error("Google Sheets INKASSA must keep expense column U empty");
    }
  }

  return { scriptVersion, row };
};

const negativeMoneyFields = (amount) => {
  const number = Number(amount || 0);
  const signed = Number.isFinite(number) ? -Math.abs(number) : amount;
  return {
    amount: signed,
    finalAmount: signed,
    totalAmount: signed,
    paidAmount: signed,
    realPaidAmount: signed,
    cashAmount: signed,
    cashUzs: signed,
    amountUzs: signed,
    amountUZS: signed,
    uzsAmount: signed,
    uzs: signed,
    cashierUzs: signed,
    signedAmount: signed,
  };
};

const positiveMoneyFields = (amount) => {
  const number = Number(amount || 0);
  const signed = Number.isFinite(number) ? Math.abs(number) : amount;
  return {
    amount: signed,
    finalAmount: signed,
    totalAmount: signed,
    paidAmount: signed,
    realPaidAmount: signed,
    cashAmount: signed,
    cashUzs: signed,
    amountUzs: signed,
    amountUZS: signed,
    uzsAmount: signed,
    uzs: signed,
    cashierUzs: signed,
    signedAmount: signed,
  };
};

const INKASSA_ROW_LABEL = "INKASSA";

const orderItems = (order) => {
  if (!Array.isArray(order?.items)) return [];
  return order.items
    .map((item) => ({
      size: String(item?.size || item?.locker?.size || "").toUpperCase(),
      count: Number(item?.count || 1),
    }))
    .filter((item) => ["S", "M", "L", "XL"].includes(item.size));
};

const orderSizeCounts = (order) => {
  const counts = { S: 0, M: 0, L: 0, XL: 0 };
  for (const item of orderItems(order)) {
    counts[item.size] += Number.isFinite(item.count) && item.count > 0 ? item.count : 1;
  }
  return counts;
};

const formatSizeCounts = (sizeCounts = {}) =>
  ["S", "M", "L", "XL"]
    .map((size) => {
      const count = Number(sizeCounts[size] || 0);
      return count > 0 ? `${count}-${size}` : null;
    })
    .filter(Boolean)
    .join(" ");

const sheetAmount = (amount, currency) => {
  if (amount === null || amount === undefined || amount === "") return null;
  const isExplicitMajor = (typeof amount === "number" && !Number.isInteger(amount))
    || (typeof amount === "string" && /[.,]/.test(amount));
  if (isExplicitMajor) {
    const major = Number(String(amount).trim().replace(/[\s\u00a0\u202f]/g, "").replace(",", "."));
    if (!Number.isFinite(major)) throw new TypeError("Invalid currency amount");
    return Math.abs(major);
  }
  return Math.abs(normalizeCurrencyAmount(amount, currency || "UZS"));
};

const orderPayload = (action, order, overrides = {}) => {
  const items = orderItems(order);
  const sizeCounts = orderSizeCounts(order);
  const payload = {
    branchCode: branchCode(order),
    branch: branchName(order),
    orderId: order?.id || order?.orderId || order?.order?.id || null,
    orderNumber: order?.orderNumber || order?.order?.orderNumber || null,
    clientName: order?.clientName || null,
    phone: order?.phone || null,
    passport: order?.passport || null,
    sizeCounts,
    items,
    checkIn: toIso(order?.checkIn),
    checkOut: toIso(order?.realPickupTime || order?.plannedCheckOut || order?.closedAt),
    period: order?.tariffHours ? `${order.tariffHours} soat` : "",
    tariffHours: order?.tariffHours || "",
    amount: order?.finalAmount ?? order?.amount ?? null,
    currency: order?.currency || null,
    paymentType: order?.paymentType || null,
    action,
    createdAt: toIso(order?.createdAt || new Date()),
    ...overrides,
  };
  const isCancel = String(action || "").toUpperCase() === "CANCEL_ORDER";
  const normalizedAmount = isCancel && payload.amount !== null && payload.amount !== undefined && payload.amount !== ""
    ? -Math.abs(sheetAmount(payload.amount, payload.currency))
    : sheetAmount(payload.amount, payload.currency);
  return withDeliveryMetadata({
    ...payload,
    amountMinor: payload.amount,
    amount: normalizedAmount,
    sheetAmount: normalizedAmount,
    amountUnit: "MAJOR",
  });
};

const basePayload = (action, entity, overrides = {}) =>
  withDeliveryMetadata({
    branchCode: branchCode(entity),
    branch: branchName(entity),
    entityId: entity?.id || entity?.orderId || entity?.order?.id || null,
    orderId: entity?.orderId || entity?.order?.id || null,
    orderNumber: entity?.orderNumber || entity?.order?.orderNumber || null,
    clientName: entity?.clientName || entity?.receiverName || null,
    recipientName: entity?.receiverName || entity?.recipientName || null,
    phone: entity?.phone || null,
    passport: entity?.passport || entity?.order?.passport || null,
    lockers: [],
    checkIn: toIso(entity?.checkIn || entity?.order?.checkIn || entity?.openedAt),
    checkOut: toIso(entity?.closedAt || entity?.order?.realPickupTime || entity?.order?.plannedCheckOut),
    amount: entity?.amount ?? entity?.closingCash ?? entity?.openingCash ?? null,
    currency: entity?.currency || null,
    paymentType: entity?.paymentType || null,
    note: entity?.note || entity?.reason || null,
    action,
    createdAt: toIso(entity?.createdAt || entity?.openedAt || new Date()),
    ...overrides,
  });

const postWebhook = async (payload) => {
  const controller = new AbortController();
  let timeout = null;

  try {
    if (!shouldDeliver(payload)) {
      return {
        skipped: true,
        reason: `Google Sheets only accepts NEW_ORDER, DOPLATA, DEBT_PAYMENT, CANCEL_ORDER, EXPENSE, INKASSA, SALARY events (received ${payload.action || "UNKNOWN"})`,
      };
    }
    if (!isEnabled()) {
      return {
        skipped: true,
        reason: `Google Sheets disabled or webhook missing (GOOGLE_SHEETS_ENABLED=${enabledValue()})`,
      };
    }
    validateBranchCode(payload);

    const finalRow = sheetMapper.buildLegacyRow_(payload);
    logger.info("[GoogleSheets] finalRow", {
      action: payload.action,
      branchCode: payload.branchCode,
      row: finalRow,
      scriptVersion: EXPECTED_SCRIPT_VERSION,
    });
    logger.info("[GoogleSheets] sending", deliveryLogMeta(payload));
    timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(getWebhookUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const responseBody = await response.text().catch(() => "");
    let json = null;
    let responseParseError = null;
    try {
      json = responseBody ? JSON.parse(responseBody) : null;
    } catch (error) {
      json = null;
      responseParseError = `Non-JSON Google Sheets response: ${summarizeWebhookBody(responseBody) || error.message}`;
    }
    logger.info("[GoogleSheets] response", {
      status: response.status,
      body: json || summarizeWebhookBody(responseBody),
      success: json?.success === true || json?.ok === true,
      scriptVersion: json?.scriptVersion || null,
      branchCode: json?.branchCode || null,
      spreadsheetId: json?.spreadsheetId || null,
      spreadsheetName: json?.spreadsheetName || null,
      sheetName: json?.sheetName || null,
      monthSheetName: json?.monthSheetName || null,
      row: Number.isInteger(json?.row) ? json.row : null,
      error: json?.error || (!response.ok ? `HTTP ${response.status}: ${summarizeWebhookBody(responseBody)}` : responseParseError),
    });
    if (!response.ok) {
      throw webhookError(
        `Google Sheets webhook failed: HTTP ${response.status}: ${json?.error || summarizeWebhookBody(responseBody) || "empty response"}`,
        { status: response.status, body: responseBody, json },
      );
    }
    if (!json) {
      throw webhookError(responseParseError || "Google Sheets webhook returned an empty response", {
        status: response.status,
        body: responseBody,
        json,
      });
    }
    if (json && (json.success === false || json.ok === false || json.error || ["error", "failed", "fail"].includes(String(json.status || "").toLowerCase()))) {
      throw webhookError(`Google Sheets webhook rejected payload: ${responseBody}`, {
        status: response.status,
        body: responseBody,
        json,
      });
    }
    const verified = validateWebhookResult(payload, json, finalRow);
    logger.info("[GoogleSheets] success", deliveryLogMeta(payload, {
      status: response.status,
      idempotencyKey: payload.idempotencyKey,
      scriptVersion: verified.scriptVersion,
      response: responseBody.slice(0, 500),
    }));
    return {
      ok: true,
      status: response.status,
      response: responseBody,
      responseJson: json,
      finalRow: verified.row,
      scriptVersion: verified.scriptVersion,
    };
  } catch (error) {
    logger.warn("[GoogleSheets] failed", deliveryLogMeta(payload, { error: error.message }));
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const deliveryKey = ({ action, entityType, entityId }) => `${action}:${entityType}:${entityId}`;

const wasDelivered = async ({ action, entityType, entityId }) => {
  if (!entityId || entityId === "google-sheets") return false;
  const existing = await prisma.auditLog.findFirst({
    where: {
      entityType,
      entityId: String(entityId),
      action: "GOOGLE_SHEETS_SENT",
      description: deliveryKey({ action, entityType, entityId }),
    },
    select: { id: true },
  });
  return Boolean(existing);
};

const markDelivered = async ({ action, branchId, userId, entityType, entityId }, result) => {
  if (!entityId || entityId === "google-sheets") return;
  await prisma.auditLog
    .create({
      data: {
        branchId,
        userId,
        entityType,
        entityId: String(entityId),
        action: "GOOGLE_SHEETS_SENT",
        description: deliveryKey({ action, entityType, entityId }),
        newValue: {
          action,
          response: result?.response || null,
        },
      },
    })
    .catch((auditError) => logger.warn("Google Sheets sent marker write failed", { message: auditError.message }));
};

const sendSafely = async (delivery, { action = "UNKNOWN", branchId = null, userId = null, entityType = "GoogleSheets", entityId = "google-sheets" } = {}) => {
  try {
    if (await wasDelivered({ action, entityType, entityId })) {
      logger.info("Google Sheets duplicate delivery skipped", { action, branchId, entityType, entityId });
      return { skipped: true, duplicate: true };
    }
    const result = await (typeof delivery === "function" ? delivery() : delivery);
    if (result?.skipped) {
      logger.warn("Google Sheets delivery skipped", { action, branchId, entityType, entityId, reason: result.reason });
      await prisma.auditLog
        .create({
          data: {
            branchId,
            userId,
            entityType,
            entityId,
            action: "GOOGLE_SHEETS_SKIPPED",
            description: `${action}: ${result.reason || "skipped"}`,
            newValue: { action, reason: result.reason || "skipped" },
          },
        })
        .catch((auditError) => logger.warn("Google Sheets audit write failed", { message: auditError.message }));
    }
    if (result?.ok) {
      await markDelivered({ action, branchId, userId, entityType, entityId }, result);
    }
    return result;
  } catch (error) {
    logger.warn("Google Sheets delivery failed", { action, branchId, entityType, entityId, message: error.message });
    await prisma.auditLog
      .create({
        data: {
          branchId,
          userId,
          entityType,
          entityId,
          action: "GOOGLE_SHEETS_SEND_ERROR",
          description: `${action}: ${error.message}`,
          newValue: {
            action,
            message: error.message,
          },
        },
      })
      .catch((auditError) => logger.warn("Google Sheets audit write failed", { message: auditError.message }));
    return {
      skipped: true,
      error: error.message,
      status: error.webhookStatus ?? null,
      response: error.webhookBody ?? null,
      responseJson: error.webhookJson ?? null,
      scriptVersion: error.webhookJson?.scriptVersion || null,
    };
  }
};

const newOrderSheetAmount = (order) =>
  order?.realPaidAmount ?? order?.finalAmount ?? order?.calculatedAmount ?? null;

const sendNewOrder = (order) =>
  postWebhook(orderPayload("NEW_ORDER", order, { amount: newOrderSheetAmount(order) }));

const sendDoplata = (order) =>
  postWebhook(orderPayload("DOPLATA", order, {
    amount: order?.overtimeAmount ?? order?.extraPayment ?? 0,
    currency: order?.overtimeCurrency || order?.currency || "UZS",
    paymentType: order?.overtimePaymentType || null,
    checkOut: toIso(order?.realPickupTime || order?.updatedAt),
    period: `DOPLATA ${Number(order?.overtimeHours || 0)}ч`,
    doplataPeriod: `DOPLATA ${Number(order?.overtimeHours || 0)}ч`,
    operationName: "Доплата",
    note: "DOPLATA",
  }));

const sendOrderCancel = (order, reversal = {}) => {
  const currency = reversal?.currency || order?.currency || "UZS";
  const amountMinor = Math.abs(Number(reversal?.amount ?? order?.realPaidAmount ?? 0));
  const amountMajor = sheetAmount(amountMinor, currency);
  return postWebhook(orderPayload("CANCEL_ORDER", order, {
    amount: -amountMajor,
    sheetAmount: -amountMajor,
    amountMinor: -amountMinor,
    amountUnit: "MAJOR",
    currency,
    paymentType: reversal?.paymentType || order?.paymentType || null,
    checkOut: toIso(order?.updatedAt || new Date()),
    operationName: "Buyurtma bekor qilindi",
    note: order?.cancelReason || "CANCEL",
  }));
};

const expensePayload = (expense) =>
  (() => {
    const expenseName = expense?.category || "Xarajat";
    const adminName = adminNameFor(expense);
    const adminLogin = expense?.createdBy?.login || expense?.adminLogin || null;
    const createdAt = toIso(expense?.createdAt || new Date());
    const sourceData = {
      id: expense?.id || null,
      branchId: expense?.branchId || expense?.branch?.id || null,
      branchCode: branchCode(expense),
      branchName: branchName(expense),
      shiftId: expense?.shiftId || null,
      category: expense?.category || null,
      reason: expense?.reason || expense?.note || null,
      amountMinor: expense?.amount ?? null,
      amount: sheetAmount(expense?.amount, expense?.currency || "UZS"),
      currency: expense?.currency || "UZS",
      createdById: expense?.createdById || expense?.createdBy?.id || null,
      adminName,
      adminLogin,
      createdAt,
    };
    return withDeliveryMetadata({
      action: "EXPENSE",
      branchCode: branchCode(expense),
      branchName: branchName(expense),
      branch: branchName(expense),
      entityId: expense?.id || null,
      branchId: sourceData.branchId,
      shiftId: sourceData.shiftId,
      createdById: sourceData.createdById,
      orderNumber: "",
      checkNumber: "",
      checkNo: "",
      receiptNumber: "",
      clientName: expenseName,
      fio: expenseName,
      fullName: expenseName,
      displayName: expenseName,
      recipientName: expenseName,
      name: expenseName,
      itemName: expenseName,
      naimenovanie: expenseName,
      category: expense?.category || null,
      reason: expense?.reason || expense?.note || null,
      period: "",
      tariffHours: "",
      storagePeriod: "",
      amount: sheetAmount(expense?.amount, expense?.currency || "UZS"),
      finalAmount: sheetAmount(expense?.amount, expense?.currency || "UZS"),
      amountMinor: expense?.amount ?? null,
      expenseAmount: sheetAmount(expense?.amount, expense?.currency || "UZS"),
      sheetAmount: sheetAmount(expense?.amount, expense?.currency || "UZS"),
      amountUnit: "MAJOR",
      currency: expense?.currency || "UZS",
      paymentType: "EXPENSE",
      skipRevenueColumns: true,
      legacySheetTarget: {
        nameColumn: 22,
      },
      adminName,
      adminLogin,
      sourceData,
      createdAt,
    });
  })();

const salaryPayload = (salary) =>
  withDeliveryMetadata({
    action: "SALARY",
    branchCode: branchCode(salary),
    branchName: branchName(salary),
    branch: branchName(salary),
    entityId: salary?.salaryEntityId || salary?.id || null,
    orderNumber: "",
    checkNumber: "",
    checkNo: "",
    receiptNumber: "",
    clientName: salary?.salaryReceiver || "Oylik",
    fio: salary?.salaryReceiver || "Oylik",
    fullName: salary?.salaryReceiver || "Oylik",
    displayName: salary?.salaryReceiver || "Oylik",
    recipientName: salary?.salaryReceiver || null,
    salaryReceiver: salary?.salaryReceiver || null,
    salaryAmountMinor: salary?.salaryAmount ?? null,
    salaryAmount: sheetAmount(salary?.salaryAmount, salary?.currency || "UZS"),
    period: "",
    tariffHours: "",
    storagePeriod: "",
    amount: sheetAmount(salary?.salaryAmount, salary?.currency || "UZS"),
    finalAmount: sheetAmount(salary?.salaryAmount, salary?.currency || "UZS"),
    sheetAmount: sheetAmount(salary?.salaryAmount, salary?.currency || "UZS"),
    amountUnit: "MAJOR",
    currency: salary?.currency || "UZS",
    paymentType: "SALARY",
    skipRevenueColumns: true,
    adminName: adminNameFor(salary, "closedBy"),
    createdAt: toIso(salary?.closedAt || salary?.createdAt || new Date()),
  });

const sendPickup = (order, extra = {}) =>
  postWebhook(
    orderPayload("PICKUP", order, {
      amount: extra.amount ?? order?.overtimeAmount ?? 0,
      currency: extra.currency || order?.currency || null,
      paymentType: extra.paymentType || order?.paymentType || null,
      checkOut: toIso(order?.realPickupTime),
    }),
  );

const sendDebtPayment = (debt, extra = {}) =>
  postWebhook(
    basePayload("DEBT_PAYMENT", debt, {
      amount: extra.amount ?? debt?.paidAmount ?? debt?.amount ?? null,
      paidAmount: extra.amount ?? debt?.paidAmount ?? debt?.amount ?? null,
      currency: extra.currency || debt?.currency || null,
      paymentType: extra.paymentType || null,
      checkOut: toIso(debt?.closedAt),
      createdAt: toIso(debt?.closedAt || debt?.createdAt || new Date()),
      period: "QARZ",
      operationName: "Qarz to'lovi",
    }),
  );

const sendDebtClosed = sendDebtPayment;

const sendExpense = (expense) => postWebhook(expensePayload(expense));

const sendSalary = (salary) => postWebhook(salaryPayload(salary));

const inkassaPayload = (inkassa) => {
  const receiver = inkassa?.receiverName || inkassa?.recipientName || null;
  const receiverLabel = receiver || INKASSA_ROW_LABEL;
  const adminName = adminNameFor(inkassa);
  const adminLogin = inkassa?.createdBy?.login || inkassa?.adminLogin || null;
  const createdAt = toIso(inkassa?.createdAt || new Date());
  const sourceData = {
    id: inkassa?.id || null,
    branchId: inkassa?.branchId || inkassa?.branch?.id || null,
    branchCode: branchCode(inkassa),
    branchName: branchName(inkassa),
    shiftId: inkassa?.shiftId || null,
    receiverName: receiver,
    note: inkassa?.note || null,
    amountMinor: inkassa?.amount ?? null,
    amount: sheetAmount(inkassa?.amount, inkassa?.currency || "UZS"),
    currency: inkassa?.currency || "UZS",
    createdById: inkassa?.createdById || inkassa?.createdBy?.id || null,
    adminName,
    adminLogin,
    createdAt,
  };

  return withDeliveryMetadata({
    action: "INKASSA",
    branchCode: branchCode(inkassa),
    branchName: branchName(inkassa),
    branch: branchName(inkassa),
    entityId: inkassa?.id || null,
    branchId: sourceData.branchId,
    shiftId: sourceData.shiftId,
    createdById: sourceData.createdById,
    orderNumber: "",
    checkNumber: "",
    checkNo: "",
    receiptNumber: "",
    receiverName: receiver,
    recipientName: receiver,
    rowLabel: receiverLabel,
    clientName: receiverLabel,
    fio: receiverLabel,
    fullName: receiverLabel,
    displayName: receiverLabel,
    name: receiver,
    itemName: receiver,
    naimenovanie: receiver,
    amount: sheetAmount(inkassa?.amount, inkassa?.currency || "UZS"),
    finalAmount: sheetAmount(inkassa?.amount, inkassa?.currency || "UZS"),
    amountMinor: inkassa?.amount ?? null,
    inkassaAmount: sheetAmount(inkassa?.amount, inkassa?.currency || "UZS"),
    sheetAmount: sheetAmount(inkassa?.amount, inkassa?.currency || "UZS"),
    amountUnit: "MAJOR",
    currency: inkassa?.currency || "UZS",
    note: inkassa?.note || "Inkassa",
    period: "",
    tariffHours: "",
    storagePeriod: "",
    paymentType: "INKASSA",
    skipRevenueColumns: true,
    sheetSection: "INKASSA",
    rowType: "OUT",
    operationName: "INKASSA",
    amountColumn: 15,
    nameColumn: 22,
    amountColumnByCurrency: {
      UZS: 15,
      USD: 16,
      EUR: 17,
      RUB: 18,
      KZT: 19,
      TJS: 20,
    },
    legacySheetTarget: {
      amountColumnByCurrency: {
        UZS: 15,
        USD: 16,
        EUR: 17,
        RUB: 18,
        KZT: 19,
        TJS: 20,
      },
      nameColumn: 22,
    },
    adminName,
    adminLogin,
    sourceData,
    createdAt,
  });
};

const sendInkassa = (inkassa) =>
  postWebhook(inkassaPayload(inkassa));

const sendShiftOpen = (shift) =>
  postWebhook(
    basePayload("SHIFT_OPEN", shift, {
      amount: shift?.openingCash ?? 0,
      currency: "UZS",
      checkIn: toIso(shift?.openedAt),
      createdAt: toIso(shift?.openedAt || shift?.createdAt || new Date()),
    }),
  );

const sendShiftClose = (shift) =>
  postWebhook(
    basePayload("SHIFT_CLOSE", shift, {
      amount: shift?.closingCash ?? 0,
      currency: "UZS",
      checkIn: toIso(shift?.openedAt),
      checkOut: toIso(shift?.closedAt),
      createdAt: toIso(shift?.closedAt || shift?.createdAt || new Date()),
    }),
  );

const testPayload = (action, branchCodeValue, branch, user) => {
  const createdAt = toIso(new Date());
  const entityId = `test:${action}:${branchCodeValue}:${Date.now()}`;
  const common = {
    branchCode: branchCodeValue,
    branchName: branch?.name || branchNameByCode[branchCodeValue] || null,
    branch: branch?.name || branchNameByCode[branchCodeValue] || null,
    entityId,
    currency: "UZS",
    adminName: formatAdminName(user, { branch, fallback: "SUPER_ADMIN" }),
    createdAt,
  };

  if (action === "NEW_ORDER") {
    return orderPayload(
      "NEW_ORDER",
      {
        id: entityId,
        branch: { code: branchCodeValue, name: common.branchName },
        orderNumber: `TEST-${branchCodeValue}-${Date.now()}`,
        clientName: "GOOGLE SHEETS TEST",
        phone: "",
        passport: "",
        items: [],
        checkIn: new Date(),
        plannedCheckOut: new Date(),
        finalAmount: 1000,
        currency: "UZS",
        paymentType: "CASH",
        createdAt: new Date(),
      },
      { entityId },
    );
  }

  if (action === "EXPENSE") {
    return expensePayload({
      id: entityId,
      branch: { code: branchCodeValue, name: common.branchName },
      category: "TEST",
      reason: "Google Sheets test expense",
      amount: 1000,
      currency: "UZS",
      adminName: common.adminName,
      createdAt: new Date(),
    });
  }

  if (action === "DOPLATA") {
    return orderPayload(
      "DOPLATA",
      {
        id: entityId,
        branch: { code: branchCodeValue, name: common.branchName },
        orderNumber: `TEST-DOPLATA-${branchCodeValue}-${Date.now()}`,
        clientName: "GOOGLE SHEETS TEST",
        phone: "",
        passport: "",
        items: [{ size: "S", count: 1 }],
        checkIn: new Date(),
        realPickupTime: new Date(),
        overtimeAmount: 1000,
        currency: "UZS",
        paymentType: "CASH",
        createdAt: new Date(),
      },
      { entityId, amount: 1000, note: "DOPLATA" },
    );
  }

  if (action === "DEBT_PAYMENT") {
    return basePayload("DEBT_PAYMENT", {
      id: entityId,
      branch: { code: branchCodeValue, name: common.branchName },
      order: { id: entityId, orderNumber: `TEST-DEBT-${branchCodeValue}-${Date.now()}` },
      clientName: "GOOGLE SHEETS TEST",
      phone: "",
      amount: 1000,
      paidAmount: 1000,
      currency: "UZS",
      paymentType: "CASH",
      createdAt: new Date(),
    }, {
      entityId,
      amount: 1000,
      paidAmount: 1000,
      period: "QARZ",
      operationName: "Qarz to'lovi",
    });
  }

  if (action === "CANCEL_ORDER") {
    return orderPayload(
      "CANCEL_ORDER",
      {
        id: entityId,
        branch: { code: branchCodeValue, name: common.branchName },
        orderNumber: `TEST-CANCEL-${branchCodeValue}-${Date.now()}`,
        clientName: "GOOGLE SHEETS TEST",
        phone: "",
        passport: "",
        items: [{ size: "S", count: 1 }],
        checkIn: new Date(),
        plannedCheckOut: new Date(),
        finalAmount: 1000,
        currency: "UZS",
        paymentType: "CASH",
        createdAt: new Date(),
      },
      { entityId, amount: -1000, operationName: "Buyurtma bekor qilindi" },
    );
  }

  if (action === "INKASSA") {
    return inkassaPayload({
      id: entityId,
      branch: { code: branchCodeValue, name: common.branchName },
      receiverName: "Google Sheets test",
      amount: 1000,
      currency: "UZS",
      note: "Google Sheets test inkassa",
      adminName: common.adminName,
      createdAt: new Date(),
    });
  }

  return salaryPayload({
    salaryEntityId: entityId,
    branch: { code: branchCodeValue, name: common.branchName },
    salaryReceiver: "Google Sheets test",
    salaryAmount: 1000,
    currency: "UZS",
    adminName: common.adminName,
    createdAt: new Date(),
  });
};

const sendTestEvent = async (user, body) => {
  const action = String(body.action || "").toUpperCase();
  const code = normalizeBranchCode(body.branchCode);
  const branch = await prisma.branch.findUnique({ where: { code }, select: { id: true, name: true, code: true } }).catch(() => null);
  const payload = testPayload(action, code, branch, user);
  const result = await sendSafely(() => postWebhook(payload), {
    action,
    branchId: branch?.id || null,
    userId: user?.id || null,
    entityType: "GoogleSheetsTest",
    entityId: payload.entityId,
  });
  return {
    action,
    branchCode: code,
    status: result?.status ?? null,
    success: Boolean(result?.ok),
    sent: Boolean(result?.ok),
    scriptVersion: result?.scriptVersion || result?.responseJson?.scriptVersion || null,
    spreadsheetId: result?.responseJson?.spreadsheetId || null,
    spreadsheetName: result?.responseJson?.spreadsheetName || null,
    sheetName: result?.responseJson?.sheetName || null,
    monthSheetName: result?.responseJson?.monthSheetName || payload.monthSheetName || null,
    row: Number.isInteger(result?.responseJson?.row) ? result.responseJson.row : null,
    error: result?.error || null,
    result,
    idempotencyKey: payload.idempotencyKey,
  };
};

module.exports = {
  sendNewOrder,
  sendDoplata,
  sendOrderCancel,
  sendPickup,
  sendDebtClosed,
  sendDebtPayment,
  sendExpense,
  sendSalary,
  sendInkassa,
  sendTestEvent,
  sendShiftOpen,
  sendShiftClose,
  sendSafely,
  _internals: {
    EXPECTED_SCRIPT_VERSION,
    EXPECTED_SPREADSHEET_ID_BY_BRANCH_CODE,
    INKASSA_COLUMN_INDEX_BY_CURRENCY,
    branchNameByCode,
    normalizeBranchCode,
    getWebhookUrl,
    maskWebhookUrl,
    summarizeWebhookBody,
    isEnabled,
    orderPayload,
    newOrderSheetAmount,
    orderSizeCounts,
    formatSizeCounts,
    basePayload,
    expensePayload,
    inkassaPayload,
    salaryPayload,
    sheetAmount,
    testPayload,
    postWebhook,
    validateBranchCode,
    validateWebhookResult,
    shouldDeliver,
  },
};
