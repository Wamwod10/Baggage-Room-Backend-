const iso = value => value == null ? null : new Date(value).toISOString();
const base = row => ({ id: row.id, branchCode: row.branch?.code || row.branchCode || row.code, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
const currencyMap = (map, fallback = 0) => Object.fromEntries(['UZS', 'USD', 'RUB', 'EUR', 'KZT', 'TJS'].map(currency => [currency, Number(map?.[currency] ?? (currency === 'UZS' ? fallback : 0))]));

function serializeRecord(endpoint, row) {
  const record = base(row);
  switch (endpoint) {
    case 'branches': return { ...record, name: row.name, isActive: row.isActive };
    case 'orders': return {
      ...record, orderNumber: row.orderNumber, status: row.status, currency: row.currency, paymentType: row.paymentType,
      calculatedAmount: row.calculatedAmount, discountAmount: row.discountAmount, finalAmount: row.finalAmount,
      recordedPaidAmount: row.realPaidAmount, overtimeAmount: row.overtimeAmount,
      overtimePaymentType: row.overtimePaymentType, checkIn: iso(row.checkIn), plannedCheckOut: iso(row.plannedCheckOut),
      realPickupTime: iso(row.realPickupTime), cancelledAt: iso(row.cancelledAt),
    };
    case 'transactions': return {
      ...record, transactionId: row.id, transactionType: row.type, direction: row.direction,
      amount: row.amount, signedAmount: row.direction === 'OUT' ? -row.amount : row.amount,
      currency: row.currency, paymentType: row.paymentType ?? null, orderId: row.orderId ?? null, shiftId: row.shiftId ?? null,
      isRevenue: ['ORDER_PAYMENT', 'DEBT_CLOSE'].includes(row.type) && row.paymentType != null && row.paymentType !== 'DEBT',
    };
    case 'shifts': return {
      ...record, status: row.status, openedAt: iso(row.openedAt), closedAt: iso(row.closedAt),
      openingCashByCurrency: currencyMap(row.openingCashByCurrency, row.openingCash),
      acceptedCashByCurrency: currencyMap(row.acceptedCashByCurrency, row.acceptedCash),
      closingCashByCurrency: row.closedAt ? currencyMap(row.closingCashByCurrency, row.closingCash) : null,
      differenceByCurrency: currencyMap(row.differenceByCurrency),
    };
    case 'expenses': return { ...record, shiftId: row.shiftId ?? null, amount: row.amount, currency: row.currency, paymentType: 'CASH', isSalary: String(row.category).toLowerCase() === 'oylik' };
    case 'inkassa': return { ...record, shiftId: row.shiftId ?? null, amount: row.amount, currency: row.currency, paymentType: 'CASH' };
    default: throw new Error('Unknown Jarvis serializer');
  }
}

function serializeSales(row) {
  return {
    ...base({ ...row, id: `sales:${row.branchCode}:${row.day}:${row.currency}:${row.paymentType}` }),
    day: row.day, currency: row.currency, paymentType: row.paymentType,
    grossReceipts: String(row.grossReceipts), refunds: String(row.refunds), netReceipts: String(row.netReceipts),
    transactionCount: Number(row.transactionCount),
  };
}

function serializeCash(row, asOf) {
  return {
    ...base({ ...row, id: `cash:${row.id}:${row.currency}` }), currency: row.currency,
    shiftId: row.shiftId ?? null, asOf: iso(asOf), baselineSource: row.shiftId ? 'LATEST_SHIFT' : 'ZERO_PLUS_LEDGER',
    openingCash: String(row.opening), acceptedCash: String(row.accepted), movementNet: String(row.movementNet),
    balance: String(BigInt(row.opening) + BigInt(row.accepted) + BigInt(row.movementNet)),
  };
}

module.exports = { serializeRecord, serializeSales, serializeCash };
