const { formatCurrency } = require("./money");
const { formatTashkentDateTime } = require("./date");

const formatReceipt = (order) => {
  const items = order.items || [];
  return {
    orderNumber: order.orderNumber,
    branch: order.branch?.name || order.branchId,
    clientName: order.clientName,
    phone: order.phone,
    passport: order.passport,
    status: order.status,
    paymentType: order.paymentType,
    checkIn: order.checkIn,
    plannedCheckOut: order.plannedCheckOut,
    realPickupTime: order.realPickupTime,
    displayCheckIn: formatTashkentDateTime(order.checkIn),
    displayPlannedCheckOut: formatTashkentDateTime(order.plannedCheckOut),
    displayRealPickupTime: formatTashkentDateTime(order.realPickupTime),
    lockers: items.map((item) => ({
      lockerId: item.lockerId,
      lockerNumber: item.lockerNumber,
      size: item.size,
      tariffHours: item.tariffHours,
      originalPrice: item.originalPrice,
      discountAmount: item.discountAmount,
      finalPrice: item.finalPrice,
      currency: item.currency,
      displayPrice: formatCurrency(item.finalPrice, item.currency),
    })),
    totals: {
      calculatedAmount: order.calculatedAmount,
      discountAmount: order.discountAmount,
      finalAmount: order.finalAmount,
      realPaidAmount: order.realPaidAmount,
      paymentDifference: order.paymentDifference,
      overtimeAmount: order.overtimeAmount,
      currency: order.currency,
      displayFinalAmount: formatCurrency(order.finalAmount, order.currency),
      displayPaidAmount: formatCurrency(order.realPaidAmount, order.currency),
    },
    note: order.note,
    createdAt: order.createdAt,
    displayCreatedAt: formatTashkentDateTime(order.createdAt),
  };
};

module.exports = { formatReceipt, formatCurrency };
