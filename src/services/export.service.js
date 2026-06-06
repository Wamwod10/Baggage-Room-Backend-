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

const exportOrders = async (user, query) => {
  const data = await orderService.listOrders(user, { ...query, limit: query.limit || 10000 });
  return query.format === "csv" ? toCsv(data.items) : data;
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
