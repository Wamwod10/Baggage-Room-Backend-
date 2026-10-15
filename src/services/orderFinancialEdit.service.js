const { AppError } = require('../utils/response');
const { currencyFractionDigits } = require('../utils/money');
const { assertMinorAmount, assertPricePermission } = require('./financialControls');
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

const planEdit = (order, body, user) => {
  const currency = body.currency || order.currency;
  const paymentType = body.paymentType || order.paymentType;
  if (currency === order.currency && paymentType === order.paymentType) return null;
  assertPricePermission(user, body.priceChangeReason);
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
  data.discountAmount = Math.max(0, data.calculatedAmount - data.finalAmount);
  data.paymentDifference = data.realPaidAmount - data.finalAmount;
  if (currency !== order.currency) data.pricingSnapshot = { ...(order.pricingSnapshot || { version: 0, tariffs: {}, dailyRates: {} }), exchangeRate: targetRate };
  for (const key of ['finalAmount', 'realPaidAmount', 'overtimeAmount']) {
    if (body[key] !== undefined && body[key] !== data[key]) throw new AppError('Valyuta/to‘lovni almashtirishni summa tahriridan alohida saqlang', 400);
  }
  const movements = [];
  for (const extra of [false, true]) {
    const group = receipts.filter((m) => isExtra(m) === extra);
    let remaining = extra ? convert(extraPaid) : data.realPaidAmount;
    group.forEach((source, index) => {
      const amount = index === group.length - 1 ? remaining : Math.min(remaining, convert(source.amount));
      remaining -= amount;
      const nextPaymentType = extra || paymentType === 'DEBT' ? source.paymentType : paymentType;
      if (source.currency !== currency || source.paymentType !== nextPaymentType) movements.push({ source, amount, currency, paymentType: nextPaymentType });
    });
  }
  return { data, movements, convert };
};

const recordEdit = async (tx, order, updated, plan, user, key, reason) => {
  const shift = await findOpenShift(tx, order.branchId);
  if (!shift) throw new AppError('Open shift required to correct payment/currency', 409);
  const sheets = require('./googleSheets.service');
  for (const { source, amount, currency, paymentType } of plan.movements) {
    const base = { branchId: order.branchId, shiftId: shift.id, orderId: order.id, type: source.type, createdById: user.id };
    await tx.cashMovement.create({ data: { ...base, direction: 'OUT', amount: source.amount, currency: source.currency,
      paymentType: source.paymentType, financialKind: 'EDIT_CORRECTION', note: `Edit correction source:${source.id}` } });
    if (amount > 0) await tx.cashMovement.create({ data: { ...base, direction: 'IN', amount, currency, paymentType,
      note: `${String(source.note || '').startsWith('Overtime') ? 'Overtime' : 'Order'} ${order.orderNumber}; edit ${key}` } });
    const identity = `ORDER_EDIT:${key}:${source.id}`;
    const payloads = [sheets._internals.orderPayload('FINANCIAL_OPERATION', order, {
      idempotencyKey: `${identity}:OUT`, amount: -source.amount, currency: source.currency, paymentType: source.paymentType,
      financialKind: 'REFUND', operationName: 'To‘lov/valyuta tuzatishi (oldingi yozuv)', note: reason, deliveryIdentity: true,
    })];
    if (amount > 0) payloads.push(sheets._internals.orderPayload('DEBT_PAYMENT', updated, {
      idempotencyKey: `${identity}:IN`, amount, currency, paymentType,
      operationName: 'To‘lov/valyuta tuzatishi (yangi yozuv)', note: reason, deliveryIdentity: true,
    }));
    for (const payload of payloads) await tx.financialOutbox.create({ data: {
      deliveryKey: payload.idempotencyKey, action: 'PAYMENT_SHEETS', payload,
    } });
  }
};

module.exports = { convertMinor, planEdit, recordEdit };
