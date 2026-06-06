const orderService = require("./order.service");
const shiftService = require("./shift.service");
const cashMovementService = require("./cashMovement.service");

const toCsv = (rows) => {
  if (!rows.length) return "";
  const flatRows = rows.map((row) => JSON.parse(JSON.stringify(row)));
  const headers = Object.keys(flatRows[0]).filter((key) => typeof flatRows[0][key] !== "object");
  const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return [headers.join(","), ...flatRows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\n");
};

const sanitizeOrderForExport = (order) => ({
  orderNumber: order.orderNumber,
  branch: order.branch?.name || "",
  clientName: order.clientName,
  phone: order.phone,
  passport: order.passport || "",
  status: order.status,
  paymentType: order.paymentType,
  currency: order.currency,
  calculatedAmount: order.calculatedAmount,
  discountAmount: order.discountAmount,
  finalAmount: order.finalAmount,
  realPaidAmount: order.realPaidAmount,
  overtimeAmount: order.overtimeAmount,
  checkIn: order.checkIn,
  plannedCheckOut: order.plannedCheckOut,
  realPickupTime: order.realPickupTime,
  lockers: Array.isArray(order.items)
    ? order.items.map((item) => `${item.lockerNumber} ${item.size}`).join("; ")
    : "",
  createdBy: order.createdBy?.name || order.createdBy?.login || "",
  createdAt: order.createdAt,
});

const exportOrders = async (user, query) => {
  const data = await orderService.listOrders(user, { ...query, limit: query.limit || 10000 });
  const items = data.items.map(sanitizeOrderForExport);
  return query.format === "csv" ? toCsv(items) : { ...data, items };
};

const exportShifts = async (user, query) => {
  const data = await shiftService.listShifts(user, query);
  return query.format === "csv" ? toCsv(data) : data;
};

const exportFinance = async (user, query) => {
  const data = await cashMovementService.listCashMovements(user, { ...query, limit: query.limit || 10000 });
  return query.format === "csv" ? toCsv(data.items) : data;
};

module.exports = { exportOrders, exportShifts, exportFinance };
