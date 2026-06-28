const logger = require("./logger");

const paymentLabels = Object.freeze({
  CASH: "Naqd",
  CARD: "Terminal",
  TERMINAL: "Terminal",
  TRANSFER: "Terminal",
  CLICK: "Click",
  PAYME: "Payme",
  DEBT: "Qarz",
});

const paymentAliases = Object.freeze({
  Naqd: "CASH",
  Karta: "CARD",
  Terminal: "TERMINAL",
  Click: "CLICK",
  Payme: "PAYME",
  Qarz: "DEBT",
  "O'tkazma": "TRANSFER",
});

const normalizePaymentType = (payment) => {
  if (payment === undefined || payment === null || payment === "") return null;
  const text = String(payment).trim();
  const upper = text.toUpperCase();
  return paymentLabels[upper] ? upper : paymentAliases[text] || null;
};

const paymentLabel = (payment, { context = "payment" } = {}) => {
  const normalized = normalizePaymentType(payment);
  if (!normalized) {
    logger.error("Payment type is missing or unsupported", { context, payment });
    return "-";
  }
  return paymentLabels[normalized];
};

module.exports = {
  paymentLabels,
  normalizePaymentType,
  paymentLabel,
};
