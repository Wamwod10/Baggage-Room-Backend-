// Read-only analytics for the *same* Telegram shift-close notification.
// Orders are attributed to the branch shift by their timestamps (no direct
// Order.shiftId exists). Cash payments are attributed by CashMovement.shiftId.
const { buildTelegramSalesSummary, convertForeignToUzs, readRate } = require("./telegramSalesReport.service");

const SIZES = Object.freeze(["S", "M", "L", "XL"]);
const isFiniteAmount = (n) => Number.isSafeInteger(n) && n >= 0;

const summarizeShiftOrders = ({ orders = [], pickups = 0, cancellations = 0, delayed = 0, movements = [], previousMovements = null } = {}) => {
  const sizes = Object.fromEntries(SIZES.map((size) => [size, 0]));
  const eligible = [];
  let missingTariffs = 0;

  for (const order of orders) {
    // A cancelled test order must not inflate the mean/maximum/minimum.
    if (order.status === "CANCELLED") continue;
    for (const item of order.items || []) {
      if (SIZES.includes(item.size)) sizes[item.size] += Number(item.count || 0);
    }
    // The saved UZS tariff is the canonical comparable baseline across currencies.
    const tariff = Number(order.calculatedAmountUZS ?? (order.currency === "UZS" ? order.calculatedAmount : NaN));
    if (isFiniteAmount(tariff)) {
      eligible.push({ number: order.orderNumber, amountUzs: tariff });
    } else {
      missingTariffs += 1;
    }
  }

  const sumTariffs = eligible.reduce((sum, order) => sum + order.amountUzs, 0);
  const descending = eligible.slice().sort((a, b) => b.amountUzs - a.amountUzs || a.number.localeCompare(b.number));
  const ascending = eligible.slice().sort((a, b) => a.amountUzs - b.amountUzs || a.number.localeCompare(b.number));

  const additional = movements.filter((movement) =>
    movement.type === "ORDER_PAYMENT" &&
    movement.direction === "IN" &&
    /^(?:Additional payment|Overtime)\s/i.test(String(movement.note || "")));
  const extra = buildTelegramSalesSummary(additional);
  const revenue = buildTelegramSalesSummary(movements);
  const previous = previousMovements === null ? null : buildTelegramSalesSummary(previousMovements);
  const comparisonPercent = previous && !previous.hasUnknownRates && !revenue.hasUnknownRates && previous.totalUzs > 0
    ? Math.round((revenue.totalUzs - previous.totalUzs) / previous.totalUzs * 100)
    : null;

  return {
    received: orders.length,
    pickups,
    cancellations,
    delayed,
    sizes,
    averageTariffUzs: eligible.length ? Math.round(sumTariffs / eligible.length) : null,
    highest: descending[0] || null,
    lowest: ascending[0] || null,
    missingTariffs,
    additionalPayments: additional.length,
    additionalTotal: extra,
    revenue,
    comparisonPercent,
  };
};

const loadShiftClosingAnalytics = async (db, shift) => {
  if (!shift?.id || !shift.branchId || !shift.openedAt || !shift.closedAt) {
    throw new Error("A closed shift with opening and closing timestamps is required");
  }
  const range = { gte: shift.openedAt, lte: shift.closedAt };
  const orderSelect = {
    orderNumber: true,
    status: true,
    currency: true,
    calculatedAmount: true,
    calculatedAmountUZS: true,
    items: { select: { size: true, count: true } },
  };
  const movementSelect = {
    type: true,
    direction: true,
    amount: true,
    currency: true,
    paymentType: true,
    note: true,
    order: { select: { currency: true, exchangeRate: true, pricingSnapshot: true } },
  };

  const [orders, pickups, cancellations, delayed, movements, previousShift] = await Promise.all([
    db.order.findMany({ where: { branchId: shift.branchId, createdAt: range }, select: orderSelect }),
    db.order.count({ where: { branchId: shift.branchId, realPickupTime: range } }),
    db.order.count({ where: { branchId: shift.branchId, cancelledAt: range } }),
    db.order.count({ where: { branchId: shift.branchId, status: { in: ["ACTIVE", "DELAYED"] }, plannedCheckOut: { lt: shift.closedAt } } }),
    db.cashMovement.findMany({ where: { shiftId: shift.id }, select: movementSelect }),
    db.shift.findFirst({
      where: { branchId: shift.branchId, id: { not: shift.id }, status: "CLOSED", closedAt: { lte: shift.openedAt } },
      orderBy: { closedAt: "desc" },
      select: { id: true },
    }),
  ]);
  const previousMovements = previousShift
    ? await db.cashMovement.findMany({ where: { shiftId: previousShift.id }, select: movementSelect })
    : null;
  return summarizeShiftOrders({ orders, pickups, cancellations, delayed, movements, previousMovements });
};

module.exports = { summarizeShiftOrders, loadShiftClosingAnalytics };
