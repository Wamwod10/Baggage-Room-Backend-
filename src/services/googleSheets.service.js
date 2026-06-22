const logger = require("../utils/logger");
const prisma = require("../config/prisma");
const { formatTashkentIso } = require("../utils/date");
const { normalizeCurrencyAmount } = require("../utils/money");

const TIMEOUT_MS = Number(process.env.GOOGLE_SHEETS_TIMEOUT_MS || 15000);

const branchNameByCode = {
  TIA: "Toshkent aeroport",
  TSV: "Toshkent Shimoliy vokzal",
  TJV: "Toshkent Janubiy vokzal",
  SVK: "Samarqand vokzal",
  SIA: "Samarqand aeroport",
};
const allowedBranchCodes = new Set(Object.keys(branchNameByCode));

const enabledValue = () => process.env.GOOGLE_SHEETS_ENABLED || process.env.GOOGLE_SHEET_ENABLED || "";
const getWebhookUrl = () => String(process.env.GOOGLE_SHEET_WEBHOOK || process.env.GOOGLE_SHEETS_WEBHOOK || "").trim();
const isEnabled = () => ["true", "1", "yes", "on"].includes(String(enabledValue()).toLowerCase()) && Boolean(getWebhookUrl());
const DELIVERABLE_ACTIONS = new Set(["NEW_ORDER", "DOPLATA", "EXPENSE", "INKASSA", "SALARY"]);
const shouldDeliver = (payload) => DELIVERABLE_ACTIONS.has(String(payload?.action || "").toUpperCase());

const toIso = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : formatTashkentIso(date);
};

const branchCode = (entity) => entity?.branch?.code || entity?.branchCode || null;

const branchName = (entity) => {
  const code = branchCode(entity);
  return branchNameByCode[code] || entity?.branchName || entity?.branch?.name || entity?.branch || null;
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

const deliveryLogMeta = (payload, extra = {}) => ({
  action: payload?.action,
  branchCode: payload?.branchCode,
  amount: payload?.amount ?? payload?.salaryAmount ?? payload?.finalAmount ?? null,
  orderNumber: payload?.orderNumber || null,
  ...extra,
});

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

const lockerItems = (order) => {
  if (!Array.isArray(order?.items)) return [];
  const counts = order.items.reduce((acc, item) => {
    const size = item.size || item.locker?.size;
    if (!size) return acc;
    acc[size] = (acc[size] || 0) + Number(item.count || 1);
    return acc;
  }, {});

  return ["S", "M", "L", "XL"]
    .filter((size) => Number(counts[size] || 0) > 0)
    .map((size) => ({ size, count: counts[size] }));
};

const formatBaggagePlaces = (items = []) =>
  ["S", "M", "L", "XL"]
    .map((size) => {
      const count = items
        .filter((item) => item.size === size)
        .reduce((total, item) => total + Number(item.count || 0), 0);
      return count > 0 ? `${count}-${size}` : null;
    })
    .filter(Boolean)
    .join(" ");

const sheetAmount = (amount, currency) => {
  if (amount === null || amount === undefined || amount === "") return null;
  return normalizeCurrencyAmount(amount, currency || "UZS");
};

const orderPayload = (action, order, overrides = {}) => {
  const lockers = lockerItems(order);
  const payload = {
    branchCode: branchCode(order),
    branch: branchName(order),
    orderId: order?.id || order?.orderId || order?.order?.id || null,
    orderNumber: order?.orderNumber || order?.order?.orderNumber || null,
    clientName: order?.clientName || null,
    phone: order?.phone || null,
    passport: order?.passport || null,
    lockers,
    places: formatBaggagePlaces(lockers),
    place: formatBaggagePlaces(lockers),
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
  return withDeliveryMetadata({
    ...payload,
    amountMinor: payload.amount,
    amount: sheetAmount(payload.amount, payload.currency),
    sheetAmount: sheetAmount(payload.amount, payload.currency),
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
        reason: `Google Sheets only accepts NEW_ORDER, DOPLATA, EXPENSE, INKASSA, SALARY events (received ${payload.action || "UNKNOWN"})`,
      };
    }
    if (!isEnabled()) {
      return {
        skipped: true,
        reason: `Google Sheets disabled or webhook missing (GOOGLE_SHEETS_ENABLED=${enabledValue()})`,
      };
    }
    validateBranchCode(payload);

    logger.info("[GoogleSheets] sending", deliveryLogMeta(payload));
    timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
    logger.info("[GoogleSheets] success", deliveryLogMeta(payload, {
      status: response.status,
      idempotencyKey: payload.idempotencyKey,
      response: responseBody.slice(0, 500),
    }));
    return { ok: true, response: responseBody };
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
    return { skipped: true, error: error.message };
  }
};

const sendNewOrder = (order) => postWebhook(orderPayload("NEW_ORDER", order, { amount: order?.finalAmount ?? null }));

const sendDoplata = (order) =>
  postWebhook(orderPayload("DOPLATA", order, {
    amount: order?.overtimeAmount ?? order?.extraPayment ?? 0,
    currency: order?.overtimeCurrency || order?.currency || "UZS",
    paymentType: order?.overtimePaymentType || order?.paymentType || "CASH",
    checkOut: toIso(order?.realPickupTime || order?.updatedAt),
    note: "DOPLATA",
  }));

const expensePayload = (expense) =>
  (() => {
    const expenseName = expense?.category || "Xarajat";
    return withDeliveryMetadata({
      action: "EXPENSE",
      branchCode: branchCode(expense),
      branchName: branchName(expense),
      branch: branchName(expense),
      entityId: expense?.id || null,
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
      adminName: expense?.createdBy?.name || expense?.createdBy?.login || expense?.adminName || null,
      createdAt: toIso(expense?.createdAt || new Date()),
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
    adminName: salary?.closedBy?.name || salary?.closedBy?.login || salary?.adminName || null,
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

const sendExpense = (expense) => postWebhook(expensePayload(expense));

const sendSalary = (salary) => postWebhook(salaryPayload(salary));

const inkassaPayload = (inkassa) => {
  const receiver = inkassa?.receiverName || inkassa?.recipientName || null;
  const receiverLabel = receiver || INKASSA_ROW_LABEL;

  return withDeliveryMetadata({
    action: "INKASSA",
    branchCode: branchCode(inkassa),
    branchName: branchName(inkassa),
    branch: branchName(inkassa),
    entityId: inkassa?.id || null,
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
    adminName: inkassa?.createdBy?.name || inkassa?.createdBy?.login || inkassa?.adminName || null,
    createdAt: toIso(inkassa?.createdAt || new Date()),
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
    adminName: user?.name || user?.login || "SUPER_ADMIN",
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
  const code = String(body.branchCode || "").trim().toUpperCase();
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
    sent: Boolean(result?.ok),
    result,
    idempotencyKey: payload.idempotencyKey,
  };
};

module.exports = {
  sendNewOrder,
  sendDoplata,
  sendPickup,
  sendDebtClosed,
  sendExpense,
  sendSalary,
  sendInkassa,
  sendTestEvent,
  sendShiftOpen,
  sendShiftClose,
  sendSafely,
  _internals: {
    branchNameByCode,
    getWebhookUrl,
    isEnabled,
    orderPayload,
    formatBaggagePlaces,
    basePayload,
    expensePayload,
    inkassaPayload,
    salaryPayload,
    sheetAmount,
    testPayload,
    postWebhook,
    validateBranchCode,
    shouldDeliver,
  },
};
