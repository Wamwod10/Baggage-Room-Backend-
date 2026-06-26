const prisma = require("../config/prisma");
const {
  orderMessage,
  shiftOpenedMessage,
  shiftClosedMessage,
  orderCancelledMessage,
  delayedBaggageMessage,
  overtimePaymentMessage,
  debtClosedMessage,
  debtPaymentMessage,
  inkassaMessage,
  expenseMessage,
  orderEditMessage,
  lockerTransferMessage,
  lockerServiceMessage,
} = require("../utils/formatTelegramMessage");
const { AppError } = require("../utils/response");
const logger = require("../utils/logger");

const pendingDeliveryKeys = new Set();

const eventFlag = {
  newOrder: "newOrderEnabled",
  shiftOpen: "shiftOpenEnabled",
  shiftClose: "shiftCloseEnabled",
  orderCancel: "orderCancelEnabled",
  delayedBaggage: "delayedBaggageEnabled",
  overtimePayment: "overtimePaymentEnabled",
  debtClosed: "debtClosedEnabled",
  inkassa: "inkassaEnabled",
  expense: "expenseEnabled",
  orderEdit: "orderEditEnabled",
  lockerTransfer: "lockerTransferEnabled",
  lockerService: "lockerServiceEnabled",
};

const hasAnyEventEnabled = (setting) => Object.values(eventFlag).some((field) => setting?.[field] !== false);

const sendRaw = async (setting, text, { requireEnabled = true } = {}) => {
  if (!setting?.botToken || !setting.groupId) return { skipped: true, reason: "missing_credentials" };
  if (requireEnabled && !setting.enabled) return { skipped: true, reason: "disabled" };
  const botToken = String(setting.botToken).trim();
  const groupId = String(setting.groupId).trim();
  if (!botToken || !groupId) return { skipped: true, reason: "missing_credentials" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: groupId, text }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new AppError(`Telegram send failed: ${body}`, 502);
  }
  return response.json();
};

const sendBranchEvent = async (branchId, event, text) => {
  const setting = await prisma.telegramSetting.findUnique({ where: { branchId } });
  const flag = eventFlag[event];
  if (!setting) return { skipped: true, reason: "settings_not_found" };
  if (flag && setting[flag] === false && hasAnyEventEnabled(setting)) {
    return { skipped: true, reason: `${flag}_disabled` };
  }
  return sendRaw(setting, text);
};

const sendNewOrder = (order) => sendBranchEvent(order.branchId, "newOrder", orderMessage(order));
const sendShiftOpen = (shift) => sendBranchEvent(shift.branchId, "shiftOpen", shiftOpenedMessage(shift));
const sendShiftClose = (shift) => sendBranchEvent(shift.branchId, "shiftClose", shiftClosedMessage(shift));
const sendOrderCancel = (order) => sendBranchEvent(order.branchId, "orderCancel", orderCancelledMessage(order));
const sendDelayedBaggage = (order) => sendBranchEvent(order.branchId, "delayedBaggage", delayedBaggageMessage(order));
const sendOvertimePayment = (order) => sendBranchEvent(order.branchId, "overtimePayment", overtimePaymentMessage(order));
const sendDebtClosed = (debt) => sendBranchEvent(debt.branchId, "debtClosed", debtPaymentMessage(debt) || debtClosedMessage(debt));
const sendInkassa = (inkassa) => sendBranchEvent(inkassa.branchId, "inkassa", inkassaMessage(inkassa));
const sendExpense = (expense) => sendBranchEvent(expense.branchId, "expense", expenseMessage(expense));
const sendOrderEdit = (order, changes) => sendBranchEvent(order.branchId, "orderEdit", orderEditMessage(order, changes));
const sendLockerTransfer = (payload, transfer) => sendBranchEvent(payload.branchId || transfer.branchId, "lockerTransfer", lockerTransferMessage(payload, transfer));
const sendLockerService = (payload) => sendBranchEvent(payload.branchId, "lockerService", lockerServiceMessage(payload));
const testSend = async (branchId) => {
  const setting = await prisma.telegramSetting.findUnique({ where: { branchId } });
  if (!setting) throw new AppError("Telegram settings not found for this branch", 404);
  if (!setting.botToken || !setting.groupId) throw new AppError("Telegram bot token and group ID are required", 400);
  return sendRaw({ ...setting, enabled: true }, "🧾 Test xabari: Telegram sozlamalari tekshirilmoqda", { requireEnabled: false });
};

const deliveryKey = ({ action, entityType, entityId }) => `telegram:${action}:${entityType}:${entityId}`;

const wasDelivered = async ({ action, entityType, entityId }) => {
  if (!entityId || entityId === "telegram") return false;
  const existing = await prisma.auditLog.findFirst({
    where: {
      entityType,
      entityId: String(entityId),
      action: "TELEGRAM_SENT",
      description: deliveryKey({ action, entityType, entityId }),
    },
    select: { id: true },
  });
  return Boolean(existing);
};

const markDelivered = async ({ action, branchId, userId, entityType, entityId }, result) => {
  if (!entityId || entityId === "telegram") return;
  await prisma.auditLog
    .create({
      data: {
        branchId,
        userId,
        entityType,
        entityId: String(entityId),
        action: "TELEGRAM_SENT",
        description: deliveryKey({ action, entityType, entityId }),
        newValue: {
          action,
          messageId: result?.result?.message_id || null,
        },
      },
    })
    .catch((auditError) => logger.warn("Telegram sent marker write failed", { message: auditError.message }));
};

const sendSafely = async (delivery, { branchId = null, userId = null, entityType = "Telegram", entityId = "telegram", action = "UNKNOWN" } = {}) => {
  const key = deliveryKey({ action, entityType, entityId });
  let ownsPendingKey = false;
  try {
    if (await wasDelivered({ action, entityType, entityId })) {
      logger.info("Telegram duplicate delivery skipped", { action, branchId, entityType, entityId });
      return { skipped: true, duplicate: true };
    }
    if (pendingDeliveryKeys.has(key)) {
      logger.info("Telegram pending duplicate delivery skipped", { action, branchId, entityType, entityId });
      return { skipped: true, duplicate: true, pending: true };
    }
    pendingDeliveryKeys.add(key);
    ownsPendingKey = true;
    const result = await (typeof delivery === "function" ? delivery() : delivery);
    if (!result?.skipped) {
      await markDelivered({ action, branchId, userId, entityType, entityId }, result);
    }
    return result;
  } catch (error) {
    logger.warn("Telegram delivery failed", { action, branchId, entityType, entityId, message: error.message });
    await prisma.auditLog
      .create({
        data: {
          branchId,
          userId,
          entityType,
          entityId,
          action: "TELEGRAM_SEND_ERROR",
          description: `${action}: ${error.message}`,
          newValue: { action, message: error.message },
        },
      })
      .catch((auditError) => logger.warn("Telegram audit write failed", { message: auditError.message }));
    return { skipped: true, error: error.message };
  } finally {
    if (ownsPendingKey) pendingDeliveryKeys.delete(key);
  }
};

module.exports = {
  sendNewOrder,
  sendShiftOpen,
  sendShiftClose,
  sendOrderCancel,
  sendDelayedBaggage,
  sendOvertimePayment,
  sendDebtClosed,
  sendInkassa,
  sendExpense,
  sendOrderEdit,
  sendLockerTransfer,
  sendLockerService,
  testSend,
  sendSafely,
  _internals: {
    deliveryKey,
    wasDelivered,
    markDelivered,
  },
};
