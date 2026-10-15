const crypto = require('node:crypto');
const prisma = require('../config/prisma');
const { AppError } = require('../utils/response');
const { getScopedBranchId } = require('../utils/scope');
const { requireIdempotencyKey } = require('../utils/idempotency');
const { audit } = require('./activity.service');
const { assertMinorAmount, lockOrder } = require('./financialControls');
const { findOpenShift } = require('./cashMovement.service');
const { markAnalyticsMutation } = require('./analyticsCache');
const logger = require('../utils/logger');
const activation = require('./financeActivation');

const parseApprovers = (raw = process.env.FINANCE_TELEGRAM_APPROVERS || '{}') => {
  const mapping = JSON.parse(raw);
  const entries = Object.entries(mapping);
  if (entries.length !== 2 || entries.some(([id, user]) => !/^[1-9]\d*$/.test(id) || typeof user !== 'string' || !user.trim())
    ) throw new AppError('Finance approver mapping is not configured', 503);
  return mapping;
};
const isConfiguredApprover = (user) => Object.values(parseApprovers()).some((mapped) =>
  mapped.startsWith('login:') ? user.login === mapped.slice(6) : user.id === mapped);
const verifyWebhookSecret = (supplied, configured = process.env.FINANCE_TELEGRAM_WEBHOOK_SECRET) => {
  if (!configured || !supplied) return false;
  const a = Buffer.from(supplied); const b = Buffer.from(configured);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const callbackDecision = (value) => {
  const match = /^finance:(approve|reject):([a-zA-Z0-9_-]{1,32})$/.exec(value || '');
  return match ? { id: match[2], decision: match[1] === 'approve' ? 'APPROVED' : 'REJECTED' } : null;
};
const botFingerprint = (token) => crypto.createHash('sha256').update(String(token).trim()).digest('hex');
const botId = (token) => /^([1-9]\d*):/.exec(String(token || '').trim())?.[1];
const branchTelegramSetting = async (client, branchId) => {
  const setting = await client.telegramSetting.findUnique({ where: { branchId } });
  if (!setting || !setting.enabled || !String(setting.groupId || '').trim() || !botId(setting.botToken)) {
    const error = new AppError('Branch Telegram delivery is not configured or disabled', 503);
    error.deliveryCode = 'BRANCH_TELEGRAM_UNAVAILABLE';
    throw error;
  }
  return { ...setting, groupId: String(setting.groupId).trim(), botToken: String(setting.botToken).trim() };
};
const telegramCall = async (method, data, setting) => {
  if (!botId(setting?.botToken)) throw new AppError('Branch Telegram bot is not configured', 503);
  const response = await fetch(`https://api.telegram.org/bot${String(setting.botToken).trim()}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(8000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    // Never propagate Telegram descriptions or token-bearing URLs into logs.
    if (method === 'editMessageText' && result.description?.includes('message is not modified')) return result;
    throw new AppError('Telegram operation failed', 502);
  }
  return result;
};
const enqueue = (tx, request, action, payload = undefined) => tx.financialOutbox.upsert({
  where: { deliveryKey: `${request.id}:${action}` }, update: {},
  create: { requestId: request.id, deliveryKey: `${request.id}:${action}`, action, ...(payload ? { payload } : {}) },
});
const requestAudit = (tx, request, userId, action, oldValue = null) => audit({
  tx, branchId: request.branchId, userId, entityType: 'FinancialRequest', entityId: request.id, action,
  oldValue: oldValue ? JSON.parse(JSON.stringify(oldValue)) : undefined,
  newValue: JSON.parse(JSON.stringify(request)), description: request.reason,
});
const createRequest = async (user, orderId, body, key) => {
  await activation.assertReady();
  const idempotencyKey = requireIdempotencyKey(key);
  parseApprovers();
  if (!String(body.reason || '').trim()) throw new AppError('Reason is required', 400);
  return prisma.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { branch: true } });
    if (!order) throw new AppError('Order not found', 404);
    getScopedBranchId(user, order.branchId);
    const replay = await tx.financialRequest.findUnique({ where: { idempotencyKey } });
    if (replay) {
      if (replay.orderId !== orderId || replay.requestedById !== user.id || replay.kind !== body.kind
        || replay.movementId !== body.movementId || replay.reason !== body.reason.trim()
        || replay.newPaymentType !== (body.newPaymentType || null)
        || (body.kind === 'REFUND' && replay.amount !== body.amount)) throw new AppError('Idempotency key payload mismatch', 409);
      return replay;
    }
    const movement = await tx.cashMovement.findUnique({ where: { id: body.movementId } });
    const editReversals = await tx.cashMovement.findMany({ where: { orderId, financialKind: 'EDIT_CORRECTION' } });
    if (editReversals.some((m) => m.note === `Edit correction source:${body.movementId}`)) throw new AppError('Payment was replaced by a recorded correction; select the current receipt', 409);
    if (!movement || movement.orderId !== orderId || movement.direction !== 'IN'
      || !['ORDER_PAYMENT', 'DEBT_CLOSE'].includes(movement.type) || movement.financialKind
      || !movement.paymentType || movement.paymentType === 'DEBT') throw new AppError('Eligible payment not found', 400);
    const prior = await tx.financialRequest.findMany({ where: { movementId: movement.id, status: { not: 'REJECTED' } } });
    if (prior.some((r) => ['PENDING', 'APPROVED_AWAITING_PAYOUT'].includes(r.status))) {
      throw new AppError('Payment already has a financial request; resolve it first', 409);
    }
    const corrections = prior.filter((r) => r.kind === 'PAYMENT_CORRECTION' && r.status === 'EXECUTED').sort((a, b) => new Date(a.decidedAt) - new Date(b.decidedAt));
    const effectivePaymentType = corrections.at(-1)?.newPaymentType || movement.paymentType;
    const reserved = prior.filter((r) => r.kind === 'REFUND').reduce((sum, r) => sum + r.amount, 0);
    const amount = body.kind === 'REFUND' ? assertMinorAmount(body.amount) : movement.amount - reserved;
    if (!amount || amount + reserved > movement.amount || body.currency !== movement.currency) throw new AppError('Refund exceeds available payment or currency mismatch', 400);
    if (!['REFUND', 'PAYMENT_CORRECTION'].includes(body.kind)) throw new AppError('Invalid request kind', 400);
    if (body.kind === 'PAYMENT_CORRECTION' && (!['CASH','TERMINAL','CLICK','PAYME','CARD','TRANSFER'].includes(body.newPaymentType)
      || body.newPaymentType === effectivePaymentType)) throw new AppError('Invalid correction payment type', 400);
    const request = await tx.financialRequest.create({ data: {
      idempotencyKey, orderId, branchId: order.branchId, requestedById: user.id, kind: body.kind,
      movementId: movement.id, amount, currency: movement.currency, oldPaymentType: effectivePaymentType,
      newPaymentType: body.kind === 'PAYMENT_CORRECTION' ? body.newPaymentType : null, reason: body.reason.trim(),
      context: { branchName: order.branch.name, orderNumber: order.orderNumber, employeeName: user.name, paymentNote: movement.note },
    } });
    await requestAudit(tx, request, user.id, 'FINANCIAL_REQUEST_CREATED');
    await enqueue(tx, request, 'TELEGRAM_REQUEST');
    return request;
  });
};
const decide = async (id, decision, telegramUserId, telegramContext) => {
  await activation.assertReady();
  if (!['APPROVED', 'REJECTED'].includes(decision)) throw new AppError('Invalid decision', 400);
  const userId = parseApprovers()[String(telegramUserId)];
  if (!userId) throw new AppError('Sizda bu amalni tasdiqlash huquqi yo‘q', 403);
  const result = await prisma.$transaction(async (tx) => {
    const linked = await tx.financialRequest.findUnique({ where: { id } });
    if (!linked) throw new AppError('Request not found', 404);
    await lockOrder(tx, linked.orderId);
    if (telegramContext) await tx.$queryRaw`SELECT "id" FROM "FinancialRequest" WHERE "id" = ${id} FOR UPDATE`;
    const request = await tx.financialRequest.findUnique({ where: { id } });
    if (telegramContext) {
      const order = await tx.order.findUnique({ where: { id: request.orderId }, select: { branchId: true } });
      const setting = await branchTelegramSetting(tx, request.branchId);
      const destination = request.context.telegramDelivery;
      if (!order || order.branchId !== request.branchId || !destination || telegramContext.branchId !== request.branchId
        || telegramContext.chatId !== destination.chatId || telegramContext.messageId !== request.messageId
        || destination.groupId !== setting.groupId || destination.botFingerprint !== botFingerprint(setting.botToken)
        || telegramContext.botFingerprint !== destination.botFingerprint) {
        throw new AppError('Sizda bu amalni tasdiqlash huquqi yo‘q', 403);
      }
    }
    const manager = await tx.user.findUnique({ where: userId.startsWith('login:') ? { login: userId.slice(6) } : { id: userId } });
    if (!manager?.isActive) throw new AppError('Sizda bu amalni tasdiqlash huquqi yo‘q', 403);
    getScopedBranchId(manager, request.branchId);
    if (request.status !== 'PENDING') return request;
    const status = decision === 'REJECTED' ? 'REJECTED' : request.kind === 'REFUND' ? 'APPROVED_AWAITING_PAYOUT' : 'EXECUTED';
    const transitioned = await tx.financialRequest.updateMany({ where: { id, status: 'PENDING' }, data: {
      status, decidedById: manager.id, telegramUserId: String(telegramUserId), decidedAt: new Date(),
      context: { ...request.context, managerName: manager.name },
    } });
    if (transitioned.count !== 1) throw new AppError('Decision already recorded', 409);
    const updated = await tx.financialRequest.findUnique({ where: { id } });
    if (status === 'EXECUTED') await executeMovement(tx, updated, manager.id);
    await requestAudit(tx, updated, manager.id, 'FINANCIAL_REQUEST_DECIDED', request);
    await enqueue(tx, updated, 'TELEGRAM_DECISION');
    return updated;
  });
  markAnalyticsMutation(result);
  return result;
};
const executeMovement = async (tx, request, userId) => {
  const source = await tx.cashMovement.findUnique({ where: { id: request.movementId } });
  const shift = await findOpenShift(tx, request.branchId);
  if (!shift) throw new AppError('Open shift required to record financial operation', 409);
  const base = { branchId: request.branchId, orderId: request.orderId, shiftId: shift.id,
    type: source.type, amount: request.amount, currency: request.currency, createdById: userId,
    note: `${request.kind} ${request.id}; source ${source.id}`, financialKind: request.kind };
  await tx.cashMovement.create({ data: { ...base, direction: 'OUT', paymentType: request.kind === 'REFUND' ? request.payoutPaymentType : request.oldPaymentType } });
  if (request.kind === 'PAYMENT_CORRECTION') {
    await tx.cashMovement.create({ data: { ...base, direction: 'IN', paymentType: request.newPaymentType } });
    if (source.type === 'ORDER_PAYMENT') {
      const isOvertime = String(source.note || '').startsWith('Overtime');
      const field = isOvertime ? 'overtimePaymentType' : 'paymentType';
      const order = await tx.order.findUnique({ where: { id: request.orderId } });
      const primary = await tx.cashMovement.findFirst({ where: { orderId: order.id, type: 'ORDER_PAYMENT', direction: 'IN', financialKind: null,
        note: { startsWith: 'Order ' } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      // Partial formal debt keeps its DEBT designation; the corrected receipt is independent.
      if (isOvertime || (primary?.id === source.id && order.paymentType !== 'DEBT')) await tx.order.update({ where: { id: order.id }, data: { [field]: request.newPaymentType } });
    }
  } else if (!String(source.note || '').startsWith('Overtime')) {
    const order = await tx.order.findUnique({ where: { id: request.orderId } });
    if (order.currency === request.currency) {
      const paid = Math.max(0, order.realPaidAmount - request.amount);
      await tx.order.update({ where: { id: order.id }, data: { realPaidAmount: paid, paymentDifference: paid - order.finalAmount } });
      const debt = await tx.debt.findUnique({ where: { orderId: order.id } });
      if (order.paymentType === 'DEBT' && debt?.status === 'OPEN' && debt.currency === request.currency) {
        const amount = assertMinorAmount(debt.amount + request.amount);
        const updatedDebt = await tx.debt.update({ where: { id: debt.id }, data: { amount } });
        await audit({ tx, branchId: order.branchId, userId, entityType: 'Debt', entityId: debt.id,
          action: 'DEBT_REFUND_RECONCILIATION', oldValue: { amount: debt.amount }, newValue: { amount: updatedDebt.amount },
          description: `Executed refund ${request.id}` });
      }
    }
  }
  await enqueue(tx, request, 'SHEETS_FINANCIAL');
};
const payout = async (user, id, body, key = `refund-payout:${id}`) => {
  await activation.assertReady();
  const payoutKey = requireIdempotencyKey(key);
  const managerCanRecord = isConfiguredApprover(user);
  const result = await prisma.$transaction(async (tx) => {
    const linked = await tx.financialRequest.findUnique({ where: { id } });
    if (!linked) throw new AppError('Request not found', 404);
    await lockOrder(tx, linked.orderId);
    const request = await tx.financialRequest.findUnique({ where: { id } });
    getScopedBranchId(user, request.branchId);
    if (!managerCanRecord && request.requestedById !== user.id) throw new AppError('Only the approved requester or approver may record this payout', 403);
    const payoutPaymentType = body.paymentType || request.oldPaymentType;
    if (!['CASH', 'CARD', 'TERMINAL', 'CLICK', 'PAYME', 'TRANSFER'].includes(payoutPaymentType)) throw new AppError('Invalid actual payout method', 400);
    if (body.amount !== request.amount || body.currency !== request.currency || !String(body.reference || '').trim()) throw new AppError('Payout must match approved amount, currency and reference', 400);
    if (request.status === 'EXECUTED' && request.kind === 'REFUND') {
      if (request.payoutIdempotencyKey !== payoutKey || request.payoutReference !== body.reference.trim()
        || request.payoutPaymentType !== payoutPaymentType) throw new AppError('Payout replay payload mismatch', 409);
      return request;
    }
    const replay = await tx.financialRequest.findUnique({ where: { payoutIdempotencyKey: payoutKey } });
    if (replay && replay.id !== id) throw new AppError('Payout key belongs to another request', 409);
    if (request.kind !== 'REFUND' || request.status !== 'APPROVED_AWAITING_PAYOUT') throw new AppError('Approved refund required', 409);
    const changed = await tx.financialRequest.updateMany({ where: { id, status: 'APPROVED_AWAITING_PAYOUT' }, data: {
      status: 'EXECUTED', payoutById: user.id, paidAt: new Date(), payoutReference: body.reference.trim(), payoutIdempotencyKey: payoutKey, payoutPaymentType,
    } });
    if (changed.count !== 1) throw new AppError('Payout already recorded', 409);
    const updated = await tx.financialRequest.findUnique({ where: { id } });
    await executeMovement(tx, updated, user.id);
    await requestAudit(tx, updated, user.id, 'REFUND_PAYOUT_RECORDED', request);
    await enqueue(tx, updated, 'TELEGRAM_PAYOUT');
    return updated;
  });
  markAnalyticsMutation(result);
  return result;
};
const list = async (user, orderId) => {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError('Order not found', 404);
  getScopedBranchId(user, order.branchId);
  const requests = await prisma.financialRequest.findMany({ where: { orderId }, orderBy: { createdAt: 'desc' } });
  const sourcePayments = await prisma.cashMovement.findMany({ where: { orderId, direction: 'IN', type: { in: ['ORDER_PAYMENT', 'DEBT_CLOSE'] }, financialKind: null }, orderBy: { createdAt: 'asc' } });
  const editReversals = await prisma.cashMovement.findMany({ where: { orderId, financialKind: 'EDIT_CORRECTION' } });
  const replaced = new Set(editReversals.map((m) => m.note?.split('source:')[1]));
  const payments = sourcePayments.filter((m) => !replaced.has(m.id)).map((m) => {
    const related = requests.filter((r) => r.movementId === m.id);
    const corrected = related.find((r) => r.kind === 'PAYMENT_CORRECTION' && r.status === 'EXECUTED');
    const refunded = related.filter((r) => r.kind === 'REFUND' && r.status !== 'REJECTED').reduce((sum, r) => sum + r.amount, 0);
    return { ...m, paymentType: corrected?.newPaymentType || m.paymentType, amount: Math.max(0, m.amount - refunded) };
  }).filter((m) => m.amount > 0);
  let canRecordPayout = false;
  try { canRecordPayout = isConfiguredApprover(user); } catch { /* Fail closed. */ }
  return { requests: requests.map((r) => ({ ...r, canRecordPayout: canRecordPayout || r.requestedById === user.id })), payments, canRecordPayout };
};
const handleCallback = async (update) => {
  const callback = update?.callback_query;
  if (!callback?.id) return;
  const data = callbackDecision(callback.data);
  if (!data) return; // Other shared-bot callback namespaces belong to their existing consumer.
  const chatId = String(callback.message?.chat?.id || '');
  const senderBotId = String(callback.message?.from?.id || '');
  const snapshot = await prisma.$transaction(async (tx) => {
    if (data) await tx.$queryRaw`SELECT "id" FROM "FinancialRequest" WHERE "id" = ${data.id} FOR UPDATE`;
    const request = data ? await tx.financialRequest.findUnique({ where: { id: data.id } }) : null;
    const settings = await tx.telegramSetting.findMany({ select: { branchId: true, botToken: true, groupId: true, enabled: true } });
    const origins = settings.filter((setting) => botId(setting.botToken) === senderBotId
      && (String(setting.groupId || '').trim() === chatId
        || setting.branchId === request?.branchId && request?.context.telegramDelivery?.chatId === chatId));
    return { request, origin: origins.length === 1 ? origins[0] : null };
  });
  let answer = 'So‘rov topilmadi';
  try {
    if (!snapshot.origin) throw new AppError('Sizda bu amalni tasdiqlash huquqi yo‘q', 403);
    if (data) {
      const result = await decide(data.id, data.decision, callback.from?.id, {
        branchId: snapshot.origin.branchId, chatId, messageId: callback.message?.message_id,
        botFingerprint: botFingerprint(snapshot.origin.botToken),
      });
      answer = result.status === 'REJECTED' ? 'Rad etildi' : 'Tasdiq qayd etildi';
    }
  } catch (error) {
    answer = error.statusCode === 403 ? 'Sizda bu amalni tasdiqlash huquqi yo‘q' : 'Amal bajarilmadi; qayta urinib ko‘ring';
    await prisma.$transaction((tx) => tx.auditLog.create({ data: {
      branchId: snapshot.request?.branchId || null, entityType: 'FinancialRequest', entityId: data?.id || 'unknown',
      action: 'FINANCIAL_CALLBACK_REJECTED', description: error.statusCode === 403 ? 'Authorization or branch context rejected' : 'Callback failed',
      newValue: { telegramUserId: String(callback.from?.id || ''), messageId: callback.message?.message_id || null },
    } }));
  }
  if (snapshot.origin) await telegramCall('answerCallbackQuery', { callback_query_id: callback.id, text: answer }, snapshot.origin);
  else logger.warn('Financial callback origin is not configured', { requestId: data?.id || null, branchId: snapshot.request?.branchId || null });
};

module.exports = { parseApprovers, callbackDecision, verifyWebhookSecret, branchTelegramSetting, botFingerprint, telegramCall, createRequest, decide, payout, list, handleCallback };
