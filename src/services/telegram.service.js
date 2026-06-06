const prisma = require("../config/prisma");
const { orderMessage, simpleMessage } = require("../utils/formatTelegramMessage");
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

const sendNewOrder = (order) => sendBranchEvent(order.branchId, "newOrder", orderMessage("New order", order));
const sendShiftOpen = (shift) => sendBranchEvent(shift.branchId, "shiftOpen", simpleMessage("Shift opened", { branch: shift.branchId, openingCash: shift.openingCash }));
const sendShiftClose = (shift) => sendBranchEvent(shift.branchId, "shiftClose", simpleMessage("Shift closed", { totalRevenue: shift.totalRevenue, difference: shift.difference }));
const sendOrderCancel = (order) => sendBranchEvent(order.branchId, "orderCancel", orderMessage("Order cancelled", order));
const sendDelayedBaggage = (order) => sendBranchEvent(order.branchId, "delayedBaggage", orderMessage("Delayed baggage", order));
const sendOvertimePayment = (order) => sendBranchEvent(order.branchId, "overtimePayment", orderMessage("Overtime payment", order));
const sendDebtClosed = (debt) => sendBranchEvent(debt.branchId, "debtClosed", simpleMessage("Debt closed", { client: debt.clientName, amount: formatCurrency(debt.amount, debt.currency) }));
const sendInkassa = (inkassa) => sendBranchEvent(inkassa.branchId, "inkassa", simpleMessage("Inkassa", { receiver: inkassa.receiverName, amount: formatCurrency(inkassa.amount, inkassa.currency) }));
const sendExpense = (expense) => sendBranchEvent(expense.branchId, "expense", simpleMessage("Expense", { category: expense.category, amount: formatCurrency(expense.amount, expense.currency) }));
const sendLockerTransfer = (payload) => sendBranchEvent(payload.branchId, "lockerTransfer", simpleMessage("Locker transfer", payload));
const sendLockerService = (payload) => sendBranchEvent(payload.branchId, "lockerService", simpleMessage("Locker service", payload));
const testSend = async (branchId) => sendBranchEvent(branchId, "newOrder", "Baggage Room test message");

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
