const prisma = require('../config/prisma');
const { lockOrder, assertMinorAmount, paidForOrder } = require('./financialControls');
const { getScopedBranchId } = require('../utils/scope');
const { requireIdempotencyKey } = require('../utils/idempotency');
const { AppError } = require('../utils/response');
const { findOpenShift } = require('./cashMovement.service');
const { audit } = require('./activity.service');
const { markAnalyticsMutation } = require('./analyticsCache');
const cbuRates = require('./cbuRates.service');
const pay = async (user, orderId, body, key) => {
  const idempotencyKey = requireIdempotencyKey(key);
  const existing = await prisma.cashMovement.findUnique({ where: { idempotencyKey } });
  if (existing) {
    if (existing.orderId !== orderId || existing.amount !== body.amount || existing.currency !== body.currency || existing.paymentType !== body.paymentType) throw new AppError('Idempotency payload mismatch', 409);
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { branchId: true } });
    if (!order) throw new AppError('Order not found', 404);
    getScopedBranchId(user, order.branchId);
    return existing;
  }
  const fx = await cbuRates.getRate(body.currency);
  const result = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { cashMovements: true, debt: true } });
    if (!order) throw new AppError('Order not found', 404);
    getScopedBranchId(user, order.branchId);
    const replay = await tx.cashMovement.findUnique({ where: { idempotencyKey } });
    if (replay) {
      if (replay.orderId !== orderId || replay.amount !== body.amount || replay.currency !== body.currency || replay.paymentType !== body.paymentType) throw new AppError('Idempotency payload mismatch', 409);
      return replay;
    }
    if (!['ACTIVE', 'DELAYED'].includes(order.status)) throw new AppError('Active order required', 409);
    assertMinorAmount(body.amount);
    if (!body.amount || body.amount > Math.max(0, order.finalAmount - paidForOrder(order))) throw new AppError('Payment exceeds outstanding balance', 400);
    if (body.currency !== order.currency || !['CASH','CARD','TERMINAL','CLICK','PAYME','TRANSFER'].includes(body.paymentType)) throw new AppError('Invalid payment currency or type', 400);
    if (order.debt?.status === 'OPEN') throw new AppError('Use the existing debt payment workflow', 409);
    const shift = await findOpenShift(tx, order.branchId);
    if (!shift) throw new AppError('Open shift required', 409);
    const movement = await tx.cashMovement.create({ data: { idempotencyKey, branchId: order.branchId,
      orderId, shiftId: shift.id, type: 'ORDER_PAYMENT', direction: 'IN', amount: body.amount, currency: body.currency,
      paymentType: body.paymentType, createdById: user.id, note: `Additional payment ${order.orderNumber}`,
      ...cbuRates.paymentSnapshot(body.amount, fx) } });
    await tx.order.update({ where: { id: orderId }, data: { realPaidAmount: { increment: body.amount }, paymentDifference: order.realPaidAmount + body.amount - order.finalAmount } });
    await audit({ tx, branchId: order.branchId, userId: user.id, entityType: 'Order', entityId: orderId, action: 'ORDER_PAYMENT_RECEIVED',
      newValue: JSON.parse(JSON.stringify(movement)), description: 'Actual outstanding payment received' });
    const receiptOrder = await tx.order.findUnique({ where: { id: orderId }, include: { branch: true, items: true } });
    const payload = require('./googleSheets.service')._internals.orderPayload('DEBT_PAYMENT', receiptOrder, {
      idempotencyKey: `ORDER_PAYMENT:${movement.id}`, createdAt: movement.createdAt.toISOString(), amount: body.amount,
      paymentType: body.paymentType, operationName: `Qo‘shimcha asosiy to‘lov ${movement.id}`, currency: body.currency,
      deliveryIdentity: true,
    });
    await tx.financialOutbox.create({ data: { deliveryKey: `PAYMENT_SHEETS:${movement.id}`, action: 'PAYMENT_SHEETS', payload } });
    return movement;
  });
  markAnalyticsMutation(result);
  return result;
};
module.exports = { pay };
