const { AppError } = require('../utils/response');
const { REVENUE_TYPES } = require('./cashAccounting.service');

const assertMinorAmount = (value) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) {
    throw new AppError('Invalid money amount in minor units', 400);
  }
  return value;
};
const assertPricePermission = (user, reason, configuredIds = process.env.PRICE_APPROVER_USER_IDS || '') => {
  const ids = configuredIds.split(',').map((id) => id.trim()).filter(Boolean);
  const logins = (process.env.PRICE_APPROVER_LOGINS || '').split(',').map((login) => login.trim()).filter(Boolean);
  if (user.role !== 'SUPER_ADMIN' && !ids.includes(user.id) && !logins.includes(user.login)) throw new AppError('Sizda narx yoki chegirmani tasdiqlash huquqi yo‘q', 403);
  if (!String(reason || '').trim()) throw new AppError('Narx o‘zgarishi uchun sabab majburiy', 400);
};
// New-order discounts are entered by authenticated branch staff without manager approval.
// Still require a recorded reason. Post-creation financial edits retain their own permission checks.
const assertDiscountReason = (reason) => {
  if (!String(reason || '').trim()) throw new AppError('Chegirma sababi majburiy', 400);
};
const validateBaggage = (items, branchCode) => {
  if (!Array.isArray(items) || !items.length) throw new AppError('At least one baggage item is required', 400);
  const sizes = ['S', 'M', 'L', ...(['TSV', 'TJV', 'SVK'].includes(branchCode) ? ['XL'] : [])];
  return items.reduce((sum, item) => {
    if (!sizes.includes(item.size) || !Number.isSafeInteger(item.count) || item.count <= 0) {
      throw new AppError('Invalid baggage size or count for this branch', 400);
    }
    return assertMinorAmount(sum + item.count);
  }, 0);
};
const paidForOrder = (order) => (order.cashMovements || [])
  .filter((m) => REVENUE_TYPES.includes(m.type) && m.currency === order.currency && m.paymentType && m.paymentType !== 'DEBT')
  .reduce((sum, m) => sum + m.amount * (m.direction === 'OUT' ? -1 : 1), 0);
// Older non-debt orders stored the agreed discount as a negative payment difference.
// Require matching receipts; refunds and formal debts must keep their own workflows.
const withRecordedDiscount = (order) => {
  const difference = order.finalAmount - order.realPaidAmount;
  if (order.paymentType === 'DEBT' || order.debt?.status === 'OPEN'
    || !Number.isSafeInteger(order.realPaidAmount) || order.realPaidAmount <= 0
    || !Number.isSafeInteger(difference) || difference <= 0
    || order.paymentDifference !== -difference || order.calculatedAmount < order.finalAmount
    || paidForOrder(order) !== order.realPaidAmount
    || (order.cashMovements || []).some((m) => m.direction === 'OUT')) return order;
  return { ...order, finalAmount: order.realPaidAmount,
    discountAmount: order.calculatedAmount - order.realPaidAmount, paymentDifference: 0 };
};
const assertPickupPaid = (order) => {
  const paid = paidForOrder(order);
  const formalDebt = order.paymentType === 'DEBT' && order.debt?.status === 'OPEN'
    && order.debt.currency === order.currency && order.debt.amount >= Math.max(0, order.finalAmount - paid);
  if (!formalDebt && paid < order.finalAmount) {
    throw new AppError('Buyurtmani yopish uchun to‘lovni to‘liq amalga oshiring yoki qarz tartibida rasmiylashtiring.', 409);
  }
};
const assertPickupTotal = (order, body, overtimeAmount, overtimePaymentType) => {
  if (body.realPaidAmount === undefined) return;
  assertMinorAmount(body.realPaidAmount);
  const total = paidForOrder(order) + Number(body.debtPaidAmount || 0)
    + (overtimePaymentType === 'DEBT' ? 0 : overtimeAmount);
  if (body.realPaidAmount !== total) throw new AppError('Real olingan summa qayd etilgan to‘lovlarga mos emas. Avvalgi to‘lovni kamaytirish uchun pul qaytarish so‘rovidan foydalaning.', 400);
};
// Serialize order/payment/debt mutations on the same row, including pickup.
const lockOrder = (tx, id) => tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${id} FOR UPDATE`;

module.exports = { assertMinorAmount, assertPricePermission, assertDiscountReason, validateBaggage, paidForOrder, withRecordedDiscount, assertPickupPaid, assertPickupTotal, lockOrder };
