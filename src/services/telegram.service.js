const prisma = require("../config/prisma");
const {
  orderMessage,
  shiftOpenedMessage,
  shiftClosedMessage,
  orderCancelledMessage,
  delayedBaggageMessage,
  overtimePaymentMessage,
  debtClosedMessage,
  inkassaMessage,
  expenseMessage,
  orderEditMessage,
  lockerTransferMessage,
  lockerServiceMessage,
} = require("../utils/formatTelegramMessage");
const { AppError } = require("../utils/response");
const { formatCurrency } = require("../utils/money");
const logger = require("../utils/logger");

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

const sendRaw = async (setting, text) => {
  if (!setting?.enabled || !setting.botToken || !setting.groupId) return { skipped: true };
  const response = await fetch(`https://api.telegram.org/bot${setting.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: setting.groupId, text }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new AppError(`Telegram send failed: ${body}`, 502);
  }
  return response.json();
};

const sendBranchEvent = async (branchId, event, text) => {
  const setting = await prisma.telegramSetting.findUnique({ where: { branchId } });
  const flag = eventFlag[event];
  if (!setting || (flag && !setting[flag])) return { skipped: true };
  return sendRaw(setting, text);
};

const sendNewOrder = (order) => sendBranchEvent(order.branchId, "newOrder", orderMessage(order));
const sendShiftOpen = (shift) => sendBranchEvent(shift.branchId, "shiftOpen", shiftOpenedMessage(shift));
const sendShiftClose = (shift) => sendBranchEvent(shift.branchId, "shiftClose", shiftClosedMessage(shift));
const sendOrderCancel = (order) => sendBranchEvent(order.branchId, "orderCancel", orderCancelledMessage(order));
const sendDelayedBaggage = (order) => sendBranchEvent(order.branchId, "delayedBaggage", delayedBaggageMessage(order));
const sendOvertimePayment = (order) => sendBranchEvent(order.branchId, "overtimePayment", overtimePaymentMessage(order));
const sendDebtClosed = (debt) => sendBranchEvent(debt.branchId, "debtClosed", debtClosedMessage(debt));
const sendInkassa = (inkassa) => sendBranchEvent(inkassa.branchId, "inkassa", inkassaMessage(inkassa));
const sendExpense = (expense) => sendBranchEvent(expense.branchId, "expense", expenseMessage(expense));
const sendLockerTransfer = (payload, transfer) => sendBranchEvent(payload.branchId || transfer.branchId, "lockerTransfer", lockerTransferMessage(payload, transfer));
const sendLockerService = (payload) => sendBranchEvent(payload.branchId, "lockerService", lockerServiceMessage(payload));
const testSend = async (branchId) => sendBranchEvent(branchId, "newOrder", "🧾 Test xabari: Telegram sozlamalari tekshirilmoqda");

const sendSafely = async (promise, { branchId = null, userId = null, entityType = "Telegram", entityId = "telegram", action = "TELEGRAM_SEND_ERROR" } = {}) => {
  try {
    return await promise;
  } catch (error) {
    logger.warn("Telegram delivery failed", { branchId, message: error.message });
    await prisma.auditLog
      .create({
        data: {
          branchId,
          userId,
          entityType,
          entityId,
          action,
          description: error.message,
          newValue: { message: error.message },
        },
      })
      .catch((auditError) => logger.warn("Telegram audit write failed", { message: auditError.message }));
    return { skipped: true, error: error.message };
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
  sendLockerTransfer,
  sendLockerService,
  testSend,
  sendSafely,
};
