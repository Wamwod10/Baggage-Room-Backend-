const logger = require("../utils/logger");

const TIMEOUT_MS = 5000;

const branchNameByCode = {
  TIA: "Toshkent aeroport",
  TSV: "Shimoliy vokzal",
  TJV: "Janubiy vokzal",
  SVK: "Samarqand vokzal",
  SIA: "Samarqand aeroport",
};

const isEnabled = () => process.env.GOOGLE_SHEETS_ENABLED === "true" && Boolean(process.env.GOOGLE_SHEET_WEBHOOK);

const toIso = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const branchCode = (entity) => entity?.branch?.code || entity?.branchCode || null;

const branchName = (entity) => {
  const code = branchCode(entity);
  return branchNameByCode[code] || entity?.branch?.name || entity?.branch || null;
};

const lockerNumbers = (order) => {
  if (!Array.isArray(order?.items)) return [];
  return order.items.map((item) => item.lockerNumber || item.locker?.number).filter((number) => number !== undefined && number !== null);
};

const orderPayload = (action, order, overrides = {}) => {
  const lockers = lockerNumbers(order);
  return {
    branchCode: branchCode(order),
    branch: branchName(order),
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
  };
};

const basePayload = (action, entity, overrides = {}) => ({
  branchCode: branchCode(entity),
  branch: branchName(entity),
  orderNumber: entity?.orderNumber || entity?.order?.orderNumber || null,
  clientName: entity?.clientName || entity?.receiverName || null,
  phone: entity?.phone || null,
  passport: entity?.passport || entity?.order?.passport || null,
  lockers: [],
  checkIn: toIso(entity?.checkIn || entity?.order?.checkIn || entity?.openedAt),
  checkOut: toIso(entity?.closedAt || entity?.order?.realPickupTime || entity?.order?.plannedCheckOut),
  amount: entity?.amount ?? entity?.closingCash ?? entity?.openingCash ?? null,
  currency: entity?.currency || null,
  paymentType: entity?.paymentType || null,
  action,
  createdAt: toIso(entity?.createdAt || entity?.openedAt || new Date()),
  ...overrides,
});

const postWebhook = async (payload) => {
  if (!isEnabled()) return { skipped: true };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(process.env.GOOGLE_SHEET_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google Sheets webhook failed: ${response.status} ${body}`);
    }

    return { ok: true };
  } finally {
    clearTimeout(timeout);
  }
};

const sendSafely = async (promise, { action = "UNKNOWN", branchId = null, entityType = "GoogleSheets", entityId = "google-sheets" } = {}) => {
  try {
    return await promise;
  } catch (error) {
    logger.warn("Google Sheets delivery failed", { action, branchId, entityType, entityId, message: error.message });
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

const sendInkassa = (inkassa) => postWebhook(basePayload("INKASSA", inkassa));

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
};
