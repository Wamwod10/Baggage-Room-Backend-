const { formatCurrency } = require("./money");

const line = (label, value) => (value === undefined || value === null || value === "" ? "" : `${label}: ${value}`);

const orderMessage = (title, order) =>
  [
    title,
    line("Order", order.orderNumber),
    line("Client", order.clientName),
    line("Phone", order.phone),
    line("Amount", formatCurrency(order.finalAmount, order.currency)),
    line("Payment", order.paymentType),
  ]
    .filter(Boolean)
    .join("\n");

const simpleMessage = (title, payload = {}) =>
  [title, ...Object.entries(payload).map(([key, value]) => line(key, value))].filter(Boolean).join("\n");

module.exports = { orderMessage, simpleMessage };
