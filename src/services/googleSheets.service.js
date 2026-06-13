const logger = require("../utils/logger");
const prisma = require("../config/prisma");
const { formatTashkentIso } = require("../utils/date");

const TIMEOUT_MS = 5000;

const branchNameByCode = {
  TIA: "Toshkent xalqaro aeroport",
  TSV: "Toshkent Shimoliy vokzal",
  TJV: "Toshkent Janubiy vokzal",
  SVK: "Samarqand vokzal",
  SIA: "Samarqand xalqaro aeroport",
};
const allowedBranchCodes = new Set(Object.keys(branchNameByCode));

const enabledValue = () => process.env.GOOGLE_SHEETS_ENABLED || process.env.GOOGLE_SHEET_ENABLED || "";
const getWebhookUrl = () => String(process.env.GOOGLE_SHEET_WEBHOOK || process.env.GOOGLE_SHEETS_WEBHOOK || "").trim();
const isEnabled = () => ["true", "1", "yes", "on"].includes(String(enabledValue()).toLowerCase()) && Boolean(getWebhookUrl());

const toIso = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : formatTashkentIso(date);
};

const branchCode = (entity) => entity?.branch?.code || entity?.branchCode || null;

const branchName = (entity) => {
  const code = branchCode(entity);
  return branchNameByCode[code] || entity?.branch?.name || entity?.branch || null;
};

const validateBranchCode = (payload) => {
  if (!payload.branchCode) {
    throw new Error(`Google Sheets payload is missing branchCode for ${payload.action || "UNKNOWN"}`);
  }
  if (!allowedBranchCodes.has(payload.branchCode)) {
    throw new Error(`Unknown Google Sheets branchCode: ${payload.branchCode}`);
  }
};

const payloadEntityId = (payload) =>
  payload.orderNumber || payload.orderId || payload.entityId || [payload.action, payload.branchCode, payload.createdAt].filter(Boolean).join(":");

const withDeliveryMetadata = (payload) => ({
  rowPolicy: "FIRST_EMPTY_ROW",
  idempotencyKey: [payload.action || "UNKNOWN", payload.branchCode || "NO_BRANCH", payloadEntityId(payload)].filter(Boolean).join(":"),
  ...payload,
});

const lockerItems = (order) => {
  if (!Array.isArray(order?.items)) return [];
  return order.items
    .map((item) => ({
      number: item.lockerNumber || item.locker?.number,
      size: item.size || item.locker?.size,
      count: item.count || 1,
    }))
    .filter((locker) => locker.number !== undefined && locker.number !== null && locker.size);
};

const orderPayload = (action, order, overrides = {}) => {
  const lockers = lockerItems(order);
  return withDeliveryMetadata({
    branchCode: branchCode(order),
    branch: branchName(order),
    orderId: order?.id || order?.orderId || order?.order?.id || null,
    orderNumber: order?.orderNumber || order?.order?.orderNumber || null,
    clientName: order?.clientName || null,
    phone: order?.phone || null,
    passport: order?.passport || null,
    lockers,
    checkIn: toIso(order?.checkIn),
    checkOut: toIso(order?.realPickupTime || order?.plannedCheckOut || order?.closedAt),
    amount: order?.finalAmount ?? order?.amount ?? null,
    currency: order?.currency || null,
    paymentType: order?.paymentType || null,
    action,
    createdAt: toIso(order?.createdAt || new Date()),
    ...overrides,
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
  if (!isEnabled()) {
    return {
      skipped: true,
      reason: `Google Sheets disabled or webhook missing (GOOGLE_SHEETS_ENABLED=${enabledValue()})`,
    };
  }
  validateBranchCode(payload);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(getWebhookUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google Sheets webhook failed: ${response.status} ${body}`);
    }

    const responseBody = await response.text().catch(() => "");
    let json = null;
    try {
      json = responseBody ? JSON.parse(responseBody) : null;
    } catch {
      json = null;
    }
    if (json && (json.success === false || json.ok === false || json.error || ["error", "failed", "fail"].includes(String(json.status || "").toLowerCase()))) {
      throw new Error(`Google Sheets webhook rejected payload: ${responseBody}`);
    }
    logger.info("Google Sheets delivery succeeded", {
      action: payload.action,
      branchCode: payload.branchCode,
      orderNumber: payload.orderNumber,
      idempotencyKey: payload.idempotencyKey,
      response: responseBody.slice(0, 500),
    });
    return { ok: true, response: responseBody };
  } finally {
    clearTimeout(timeout);
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

const sendSafely = async (promise, { action = "UNKNOWN", branchId = null, userId = null, entityType = "GoogleSheets", entityId = "google-sheets" } = {}) => {
  try {
    if (await wasDelivered({ action, entityType, entityId })) {
      logger.info("Google Sheets duplicate delivery skipped", { action, branchId, entityType, entityId });
      return { skipped: true, duplicate: true };
    }
    const result = await promise;
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
    return { skipped: true, error: error.message };
  }
};

const sendNewOrder = (order) => postWebhook(orderPayload("NEW_ORDER", order, { amount: order?.finalAmount ?? null }));

const sendPickup = (order, extra = {}) =>
  postWebhook(
    orderPayload("PICKUP", order, {
      amount: extra.amount ?? order?.overtimeAmount ?? 0,
      currency: extra.currency || order?.currency || null,
      paymentType: extra.paymentType || order?.paymentType || null,
      checkOut: toIso(order?.realPickupTime),
    }),
  );

const sendDebtClosed = (debt, extra = {}) =>
  postWebhook(
    basePayload("DEBT_CLOSED", debt, {
      amount: extra.amount ?? debt?.amount ?? null,
      currency: extra.currency || debt?.currency || null,
      paymentType: extra.paymentType || null,
      checkOut: toIso(debt?.closedAt),
      createdAt: toIso(debt?.closedAt || debt?.createdAt || new Date()),
    }),
  );

const sendExpense = (expense) => postWebhook(basePayload("EXPENSE", expense));

const sendInkassa = (inkassa) =>
  postWebhook(
    basePayload("INKASSA", inkassa, {
      clientName: inkassa?.receiverName || inkassa?.recipientName || null,
      recipientName: inkassa?.receiverName || inkassa?.recipientName || null,
      note: inkassa?.note || null,
      sheetSection: "INKASSA",
      rowType: "OUT",
      displayName: "Inkassa",
      operationName: "INKASSA",
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
    }),
  );

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

module.exports = {
  sendNewOrder,
  sendPickup,
  sendDebtClosed,
  sendExpense,
  sendInkassa,
  sendShiftOpen,
  sendShiftClose,
  sendSafely,
  _internals: {
    branchNameByCode,
    getWebhookUrl,
    isEnabled,
    orderPayload,
    basePayload,
    validateBranchCode,
  },
};
