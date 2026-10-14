const prisma = require('../config/prisma');
const finance = require('../services/financialApproval.service');
const sheets = require('../services/googleSheets.service');
const { formatCurrency } = require('../utils/money');
const { formatTashkentDateTime } = require('../utils/date');
const logger = require('../utils/logger');

const message = (r) => [
  `🔔 ${r.kind === 'REFUND' ? 'REFUND SO‘ROVI' : 'TO‘LOV TURINI TUZATISH'}`,
  `🏢 Filial: ${r.context.branchName}`, `👤 Xodim: ${r.context.employeeName}`,
  `🧳 Buyurtma: #${r.context.orderNumber}`, `💰 Summa: ${formatCurrency(r.amount, r.currency)}`,
  `💳 To‘lov: ${r.oldPaymentType}${r.newPaymentType ? ` → ${r.newPaymentType}` : ''}`,
  `📝 Sabab: ${r.reason}`, `🕐 Vaqt: ${formatTashkentDateTime(r.createdAt)}`,
  `Status: ${r.status}`, ...(r.decidedAt ? [`Qaror: ${r.context.managerName} — ${formatTashkentDateTime(r.decidedAt)}`] : []),
  ...(r.paidAt ? [`Payout: ${formatTashkentDateTime(r.paidAt)}; ${r.payoutPaymentType}; ${r.payoutReference}`] : []),
].join('\n');
const keyboard = (r) => ({ inline_keyboard: r.status === 'PENDING' ? [[
  { text: '✅ Tasdiqlash', callback_data: `finance:approve:${r.id}` },
  { text: '❌ Rad etish', callback_data: `finance:reject:${r.id}` },
]] : [] });
const deliver = async (entry, tx) => {
  if (entry.action === 'PAYMENT_SHEETS') {
    const result = await sheets._internals.postWebhook(entry.payload);
    if (!result?.ok) throw new Error('Sheets payment delivery failed');
    return;
  }
  const request = await tx.financialRequest.findUnique({ where: { id: entry.requestId } });
  if (entry.action === 'SHEETS_FINANCIAL') {
    const order = await tx.order.findUnique({ where: { id: request.orderId }, include: { branch: true, items: true } });
    const signedAmount = request.kind === 'REFUND' ? -request.amount : request.amount;
    const payload = sheets._internals.orderPayload('FINANCIAL_OPERATION', order, {
      entityId: request.id, idempotencyKey: `FINANCIAL_OPERATION:${request.id}`, createdAt: (request.paidAt || request.decidedAt).toISOString(),
      amount: signedAmount, currency: request.currency, paymentType: request.kind === 'REFUND' ? request.payoutPaymentType : request.oldPaymentType,
      newPaymentType: request.newPaymentType, financialKind: request.kind, operationName: `${request.kind} ${request.id}`,
      adminName: request.context.managerName, note: request.reason,
    });
    const result = await sheets._internals.postWebhook(payload);
    if (!result?.ok) throw new Error('Sheets financial delivery failed');
    return;
  }
  // Serialize delivery metadata with callbacks so a decision cannot lose its audit context.
  await tx.$queryRaw`SELECT "id" FROM "FinancialRequest" WHERE "id" = ${request.id} FOR UPDATE`;
  const current = await tx.financialRequest.findUnique({ where: { id: request.id } });
  const order = await tx.order.findUnique({ where: { id: current.orderId }, select: { branchId: true } });
  if (!order || order.branchId !== current.branchId) {
    const error = new Error('Financial request branch does not match its order');
    error.deliveryCode = 'REQUEST_BRANCH_MISMATCH';
    throw error;
  }
  const setting = await finance.branchTelegramSetting(tx, current.branchId);
  const destination = current.context.telegramDelivery;
  const fingerprint = finance.botFingerprint(setting.botToken);
  if (current.messageId && (!destination || destination.groupId !== setting.groupId || destination.botFingerprint !== fingerprint)) {
    const error = new Error('Telegram delivery destination changed or is unbound');
    error.deliveryCode = 'TELEGRAM_DESTINATION_MISMATCH';
    throw error;
  }
  const data = { chat_id: setting.groupId, text: message(current), reply_markup: keyboard(current) };
  if (current.messageId) {
    await finance.telegramCall('editMessageText', { ...data, message_id: current.messageId }, setting);
  } else {
    const result = await finance.telegramCall('sendMessage', data, setting);
    const messageId = result.result?.message_id;
    const chatId = String(result.result?.chat?.id || setting.groupId);
    if (!Number.isSafeInteger(messageId) || messageId <= 0 || /^-?\d+$/.test(setting.groupId) && chatId !== setting.groupId) {
      throw new Error('Invalid Telegram delivery response');
    }
    await tx.financialRequest.update({ where: { id: current.id }, data: {
      messageId, context: { ...current.context, telegramDelivery: { groupId: setting.groupId, chatId, botFingerprint: fingerprint } },
    } });
  }
  await tx.auditLog.create({ data: { branchId: current.branchId, entityType: 'FinancialRequest', entityId: current.id,
    action: 'FINANCIAL_TELEGRAM_DELIVERED', description: entry.action } });
};
const flushOne = () => prisma.$transaction(async (tx) => {
  const rows = await tx.$queryRaw`SELECT * FROM "FinancialOutbox" WHERE "deliveredAt" IS NULL AND "availableAt" <= NOW()
    ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED`;
  const entry = rows[0];
  if (!entry) return false;
  try {
    await deliver(entry, tx);
    await tx.financialOutbox.update({ where: { id: entry.id }, data: { deliveredAt: new Date(), lastError: null } });
  } catch (error) {
    const request = entry.requestId ? await tx.financialRequest.findUnique({ where: { id: entry.requestId }, select: { branchId: true } }) : null;
    const reason = error.deliveryCode || 'DELIVERY_FAILED';
    logger.warn('Financial delivery failed; retry scheduled', { requestId: entry.requestId || null, branchId: request?.branchId || null, action: entry.action, reason });
    await tx.financialOutbox.update({ where: { id: entry.id }, data: {
      attempts: { increment: 1 }, availableAt: new Date(Date.now() + Math.min(3600000, 10000 * 2 ** Math.min(entry.attempts, 8))),
      lastError: `${reason}; will retry`,
    } });
    await tx.auditLog.create({ data: { branchId: request?.branchId || null, entityType: 'FinancialDelivery', entityId: entry.requestId || entry.deliveryKey,
      action: 'FINANCIAL_DELIVERY_RETRY', description: `${entry.action}: ${reason}` } });
  }
  return true;
}, { timeout: 30000 });
const startFinancialOutboxJob = () => {
  if (process.env.FINANCE_OUTBOX_ENABLED !== 'true') return { stop() {} };
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await flushOne(); } catch { /* Leave undelivered entries for the next tick. */ }
    finally { running = false; }
  }, 5000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
};
module.exports = { startFinancialOutboxJob, flushOne, message, keyboard };
