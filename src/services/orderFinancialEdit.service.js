const { AppError } = require('../utils/response');
const { currencyFractionDigits } = require('../utils/money');
const { assertMinorAmount, assertPricePermission, assertDiscountReason } = require('./financialControls');
const { findOpenShift } = require('./cashMovement.service');

const convertMinor = (amount, from, to, sourceRate = 1, targetRate = 1) => {
  assertMinorAmount(amount);
  if (from === to) return amount;
  const rate = (value) => {
    const text = String(value);
    if (!/^\d+(\.\d{1,12})?$/.test(text) || Number(text) <= 0) throw new AppError('Valyuta kursi noto‘g‘ri yoki kiritilmagan', 400);
    const [whole, fraction = ''] = text.split('.');
    return [BigInt(whole + fraction), 10n ** BigInt(fraction.length)];
  };
  const [s, sd] = rate(from === 'UZS' ? 1 : sourceRate);
  const [t, td] = rate(to === 'UZS' ? 1 : targetRate);
  if (currencyFractionDigits[from] === undefined || currencyFractionDigits[to] === undefined) throw new AppError('Invalid currency', 400);
  const numerator = BigInt(amount) * s * td * 10n ** BigInt(currencyFractionDigits[to]);
  const denominator = sd * t * 10n ** BigInt(currencyFractionDigits[from]);
  return assertMinorAmount(Number((numerator * 2n + denominator) / (2n * denominator)));
};

const planEdit = (order, body, user, { requireManagerApproval = false } = {}) => {
  const currency = body.currency || order.currency;
  const paymentType = body.paymentType || order.paymentType;
  const amountChanged = body.realPaidAmount !== undefined && body.realPaidAmount !== order.realPaidAmount;
  const overtimeType = body.overtimePaymentType || body.doplataPaymentType || order.overtimePaymentType;
  const overtimeChanged = (body.overtimeAmount !== undefined && body.overtimeAmount !== order.overtimeAmount)
    || overtimeType !== order.overtimePaymentType;
  if (currency === order.currency && paymentType === order.paymentType && !amountChanged && !body.paidPaymentType && !overtimeChanged) return null;
  if (overtimeChanged && (overtimeType === 'DEBT' || order.overtimePaymentType === 'DEBT')) throw new AppError('Use the debt/payment workflow', 400);
  if (requireManagerApproval) assertPricePermission(user, body.priceChangeReason);
  else assertDiscountReason(body.priceChangeReason);
  if (body.paidPaymentType && !['CASH','CARD','TERMINAL','CLICK','PAYME','TRANSFER'].includes(body.paidPaymentType)) throw new AppError('Haqiqiy olingan to‘lov turini tanlang', 400);
  if ((paymentType === 'DEBT') !== (order.paymentType === 'DEBT')) throw new AppError('Qarzga o‘tkazish yoki qarzni yopish uchun qarz/to‘lov tartibidan foydalaning', 400);
  const sourceRate = order.currency === 'UZS' ? 1 : order.pricingSnapshot?.exchangeRate || body.sourceExchangeRate;
  const targetRate = currency === 'UZS' ? 1 : body.exchangeRate;
  const convert = (amount) => convertMinor(amount || 0, order.currency, currency, sourceRate, targetRate);
  const reversed = new Set((order.cashMovements || []).filter((m) => m.financialKind === 'EDIT_CORRECTION').map((m) => m.note?.split('source:')[1]));
  const receipts = (order.cashMovements || []).filter((m) => m.direction === 'IN' && !m.financialKind
    && ['ORDER_PAYMENT', 'DEBT_CLOSE'].includes(m.type) && !reversed.has(m.id));
  if (receipts.some((m) => m.currency !== order.currency || !m.paymentType || m.paymentType === 'DEBT')) throw new AppError('Mixed-currency or invalid receipts require reconciliation', 409);
  const isExtra = (m) => String(m.note || '').startsWith('Overtime');
  const basePaid = receipts.filter((m) => !isExtra(m)).reduce((sum, m) => sum + m.amount, 0);
  const extraPaid = receipts.filter(isExtra).reduce((sum, m) => sum + m.amount, 0);
  if (basePaid !== order.realPaidAmount || extraPaid !== (order.overtimePaymentType === 'DEBT' ? 0 : Number(order.overtimeAmount || 0))) {
    throw new AppError('Recorded receipts require reconciliation before currency/payment correction', 409);
  }
  const data = { currency, paymentType, calculatedAmount: convert(order.calculatedAmount),
    finalAmount: convert(order.finalAmount), realPaidAmount: convert(order.realPaidAmount), overtimeAmount: convert(order.overtimeAmount) };
  if (body.realPaidAmount !== undefined) data.realPaidAmount = assertMinorAmount(body.realPaidAmount);
  if (body.finalAmount !== undefined) data.finalAmount = assertMinorAmount(body.finalAmount);
  if (data.finalAmount > data.calculatedAmount) throw new AppError('Final amount exceeds calculated price', 400);
  if (paymentType !== 'DEBT' && data.realPaidAmount < data.finalAmount) data.finalAmount = data.realPaidAmount;
  if (paymentType === 'DEBT' && data.realPaidAmount > data.finalAmount) throw new AppError('Debt payment exceeds price', 400);
  data.discountAmount = Math.max(0, data.calculatedAmount - data.finalAmount);
  data.paymentDifference = data.realPaidAmount - data.finalAmount;
  if (currency !== order.currency) data.pricingSnapshot = { ...(order.pricingSnapshot || { version: 0, tariffs: {}, dailyRates: {} }), exchangeRate: targetRate };
  if (body.overtimeAmount !== undefined) data.overtimeAmount = assertMinorAmount(body.overtimeAmount);
  if (overtimeType) data.overtimePaymentType = overtimeType;
  const movements = [];
  for (const extra of [false, true]) {
    const group = receipts.filter((m) => isExtra(m) === extra);
    let remaining = extra ? (data.overtimePaymentType === 'DEBT' ? 0 : data.overtimeAmount) : data.realPaidAmount;
    if (!group.length && remaining > 0) {
      const paidType = extra ? data.overtimePaymentType : paymentType === 'DEBT' ? body.paidPaymentType : paymentType;
      if (!['CASH','CARD','TERMINAL','CLICK','PAYME','TRANSFER'].includes(paidType)) throw new AppError('Haqiqiy olingan to‘lov turini tanlang', 400);
      group.push({ id: extra ? 'initial-extra' : 'initial', note: extra ? 'Overtime' : 'Order', type: 'ORDER_PAYMENT', direction: 'IN', amount: 0, currency: order.currency, paymentType: paidType });
    }
    group.forEach((source, index) => {
      const amount = index === group.length - 1 ? remaining : Math.min(remaining, convert(source.amount));
      remaining -= amount;
      const nextPaymentType = extra ? data.overtimePaymentType : paymentType === 'DEBT' ? body.paidPaymentType || source.paymentType : paymentType;
      if (source.currency !== currency || source.paymentType !== nextPaymentType || source.amount !== amount) movements.push({ source, amount, currency, paymentType: nextPaymentType });
    });
  }
  return { data, movements, convert };
};

const recordEdit = async (tx, order, updated, plan, user, key, reason, fx) => {
  const shift = await findOpenShift(tx, order.branchId);
  if (!shift) throw new AppError('Open shift required to correct payment/currency', 409);
  const sheets = require('./googleSheets.service');
  for (const { source, amount, currency, paymentType } of plan.movements) {
    const base = { branchId: order.branchId, shiftId: shift.id, orderId: order.id, type: source.type, createdById: user.id };
    const { paymentSnapshot } = require('./cbuRates.service');
    const originalFx = source.fxRateDate && source.uzsEquivalent != null
      ? { fxRate: source.fxRate, fxRateDate: source.fxRateDate, fxNominal: source.fxNominal,
        fxSource: source.fxSource, uzsEquivalent: source.uzsEquivalent }
      : fx && fx.currency === source.currency ? paymentSnapshot(source.amount, fx) : {};
    const nextFx = fx && fx.currency === currency ? paymentSnapshot(amount, fx) : {};
    if (source.amount > 0) await tx.cashMovement.create({ data: { ...base, direction: 'OUT', amount: source.amount, currency: source.currency,
      paymentType: source.paymentType, financialKind: 'EDIT_CORRECTION', note: `Edit correction source:${source.id}`,
      ...originalFx } });
    if (amount > 0) await tx.cashMovement.create({ data: { ...base, direction: 'IN', amount, currency, paymentType,
      note: `${String(source.note || '').startsWith('Overtime') ? 'Overtime' : 'Order'} ${order.orderNumber}; edit ${key}`,
      ...nextFx } });
    const identity = `ORDER_EDIT:${key}:${source.id}`;
    const payloads = source.amount > 0 ? [sheets._internals.orderPayload('FINANCIAL_OPERATION', order, {
      idempotencyKey: `${identity}:OUT`, amount: -source.amount, currency: source.currency, paymentType: source.paymentType,
      financialKind: 'REFUND', operationName: 'To‘lov/valyuta tuzatishi (oldingi yozuv)', note: reason, deliveryIdentity: true,
    })] : [];
    if (amount > 0) payloads.push(sheets._internals.orderPayload('DEBT_PAYMENT', updated, {
      idempotencyKey: `${identity}:IN`, amount, currency, paymentType,
      operationName: 'To‘lov/valyuta tuzatishi (yangi yozuv)', note: reason, deliveryIdentity: true,
    }));
    for (const payload of payloads) await tx.financialOutbox.create({ data: {
      deliveryKey: payload.idempotencyKey, action: 'PAYMENT_SHEETS', payload,
    } });
  }
};

const debtBalance = (order, plan) => {
  const debt = order.debt;
  const previousBase = Math.max(0, order.finalAmount - order.realPaidAmount);
  if (debt?.status === 'OPEN' && debt.amount >= previousBase) return assertMinorAmount(
    Math.max(0, plan.data.finalAmount - plan.data.realPaidAmount) + plan.convert(debt.amount - previousBase));
  return plan.convert(debt?.amount || 0);
};
const convertForPickup = async (tx, order, body, user, key) => {
  if (!body.currency || body.currency === order.currency) return order;
  const plan = planEdit(order, { currency: body.currency, exchangeRate: body.exchangeRate,
    sourceExchangeRate: body.sourceExchangeRate, priceChangeReason: body.priceChangeReason }, user, { requireManagerApproval: true });
  const requests = await tx.financialRequest.findMany({ where: { orderId: order.id, status: { not: 'REJECTED' } } });
  if (requests.length) throw new AppError('Avval mavjud moliyaviy so‘rovlarni yarashtiring', 409);
  const items = [];
  for (const item of order.items) {
    const data = { currency: plan.data.currency, unitPrice: plan.convert(item.unitPrice), originalPrice: plan.convert(item.originalPrice),
      discountAmount: plan.convert(item.discountAmount), finalPrice: plan.convert(item.finalPrice) };
    await tx.orderItem.update({ where: { id: item.id }, data });
    items.push({ ...item, ...data });
  }
  await tx.order.update({ where: { id: order.id }, data: { ...plan.data, priceApprovedById: user.id, priceApprovedByName: user.name } });
  let debt = order.debt;
  if (debt) {
    const data = { amount: debtBalance(order, plan), currency: plan.data.currency };
    await tx.debt.update({ where: { id: debt.id }, data });
    debt = { ...debt, ...data };
  }
  const updated = { ...order, ...plan.data, items, debt };
  await recordEdit(tx, order, updated, plan, user, `${key}:currency`, body.priceChangeReason);
  updated.cashMovements = await tx.cashMovement.findMany({ where: { orderId: order.id } });
  await tx.auditLog.create({ data: { branchId: order.branchId, userId: user.id, entityType: 'Order', entityId: order.id,
    action: 'ORDER_CURRENCY_CORRECTION', oldValue: JSON.parse(JSON.stringify(order)), newValue: JSON.parse(JSON.stringify(updated)), description: body.priceChangeReason } });
  return updated;
};
module.exports = { convertMinor, planEdit, recordEdit, convertForPickup, debtBalance };
