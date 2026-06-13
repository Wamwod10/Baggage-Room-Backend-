const { currencyFractionDigits } = require("./money");
const { formatTashkentDateTime } = require("./date");

const safe = (value, fallback = "-") => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  return value;
};

const isLikelyDatabaseId = (value = "") => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length >= 12 && !/\s/.test(trimmed) && /^[A-Za-z0-9_-]+$/.test(trimmed);
};

const cleanText = (value, fallback = "-") => {
  const result = safe(value, fallback);
  if (typeof result === "string" && isLikelyDatabaseId(result)) return fallback;
  return result;
};

const formatMoney = (amount, currency = "UZS") => {
  const code = (currency || "UZS").toUpperCase();
  const digits = currencyFractionDigits[code] ?? 2;
  const major = Number(amount || 0) / 10 ** digits;
  const formatted = new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(major).replace(/[\u00a0\u202f]/g, " ");

  if (code === "UZS") return `${formatted} so'm`;
  return `${formatted} ${code}`;
};

const formatDate = (date) => {
  if (!date) return "-";
  return formatTashkentDateTime(date);
};

const formatDateMinute = (date) => {
  const value = formatDate(date);
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!match) return value;
  const [, year, month, day, hour, minute] = match;
  return `${day}.${month}.${year} ${hour}:${minute}`;
};

const formatPayment = (payment) => {
  switch (String(payment || "").toUpperCase()) {
    case "CASH":
      return "Naqd";
    case "CARD":
      return "Karta";
    case "TRANSFER":
      return "O'tkazma";
    case "DEBT":
      return "Qarz";
    default:
      return "-";
  }
};

const formatBranch = (branch) => {
  if (!branch) return "-";
  if (typeof branch === "object") return cleanText(branch.name || branch.title || branch.displayName);
  return cleanText(branch);
};

const formatAdmin = (user) => {
  if (!user) return "-";
  if (typeof user === "object") return cleanText(user.name || user.fullName || user.login || user.adminName);
  return cleanText(user);
};

const shiftCashLeft = (shift = {}) => shift.systemExpectedCash ?? shift.closingCash ?? 0;

const formatLockerNumber = (value) => {
  const number = cleanText(value);
  return number === "-" ? "-" : `#${number}`;
};

const orderNumber = (order = {}) => cleanText(order.orderNumber || order.displayId);
const line = (label, value) => `${label}: ${cleanText(value)}`;

const orderMessage = (order = {}) => {
  const items = Array.isArray(order.items) ? order.items : [];
  const sizeLabel = { S: "Small", M: "Medium", L: "Large", XL: "XL" };
  const sizeCounts = items.reduce((acc, item) => {
    const size = sizeLabel[item.size] || cleanText(item.size);
    if (!size || size === "-") return acc;
    acc[size] = (acc[size] || 0) + Number(item.count || 1);
    return acc;
  }, {});
  const sizes = Object.entries(sizeCounts).map(([size, count]) => `${size}: ${count} ta`);
  const count = Object.values(sizeCounts).reduce((total, value) => total + value, 0) || Number(order.count || 0);

  return [
    "рџ“¦ Yangi baggage qabul qilindi",
    "",
    line("рџЏў Filial", formatBranch(order.branch || order.branchName)),
    line("рџ‘¤ Klient", order.clientName || order.client),
    line("рџ“ћ Telefon", order.phone),
    line("рџЄЄ Passport", order.passport),
    "",
    line("рџ§і Size", sizes.join(", ") || "-"),
    line("рџ”ў Soni", `${count} ta`),
    "",
    line("рџ•’ Check-in", formatDate(order.checkIn || order.createdAt)),
    line("рџ• Check-out", formatDate(order.plannedCheckOut)),
    "",
    line("рџ’і To'lov", formatPayment(order.paymentType)),
    line("рџ’° Summa", formatMoney(order.realPaidAmount || order.finalAmount || 0, order.currency)),
    "",
    line("рџ†” Order", orderNumber(order)),
    line("рџ“… Sana", formatDate(order.createdAt || order.checkIn)),
  ].join("\n");
};

const shiftOpenedMessage = (shift = {}) => [
  "рџџў Kassa ochildi",
  "",
  line("рџЏў Filial", formatBranch(shift.branch || shift.branchName)),
  line("рџ‘¤ Admin", formatAdmin(shift.openedBy || shift.admin || shift.openedByName)),
  ...(shift.shiftTime ? [line("рџ• Shift", shift.shiftTime), ""] : [""]),
  line("рџ•’ Ochildi", formatDate(shift.openedAt || shift.createdAt)),
  line("рџ’µ Opening cash", formatMoney(shift.openingCash || 0, shift.currency || "UZS")),
  line("рџ’° Qabul qilingan", formatMoney(shift.acceptedCash || 0, shift.currency || "UZS")),
  line("рџ“… Sana", formatDate(shift.openedAt || shift.createdAt)),
].join("\n");

const shiftClosedMessage = (shift = {}) => [
  "рџ”ґ Smena yopildi",
  "",
  line("рџЏў Filial", formatBranch(shift.branch || shift.branchName)),
  line("рџ‘¤ Topshirgan", formatAdmin(shift.openedBy || shift.admin || shift.openedByName)),
  line("рџ‘¤ Yopgan", formatAdmin(shift.closedBy || shift.closedByName)),
  ...(shift.shiftTime ? [line("рџ• Shift", shift.shiftTime)] : []),
  "",
  line("рџ“¦ Buyurtmalar", `${Number(shift.ordersCount || shift.orders || 0)} ta`),
  line("рџ’° Umumiy tushum", formatMoney(shift.totalRevenue || 0, shift.currency || "UZS")),
  line("рџ’µ Naqd", formatMoney(shift.cashRevenue || 0, shift.currency || "UZS")),
  line("рџ’і Karta", formatMoney(shift.cardRevenue || 0, shift.currency || "UZS")),
  line("рџЏ¦ O'tkazma", formatMoney(shift.transferRevenue || 0, shift.currency || "UZS")),
  "",
  line("рџ’ё Xarajat", formatMoney(shift.expenseAmount || 0, shift.currency || "UZS")),
  line("рџЏ¦ Inkassa", formatMoney(shift.inkassaAmount || 0, shift.currency || "UZS")),
  line("рџ“ќ Ochiq qarz", formatMoney(shift.debtAmount || 0, shift.currency || "UZS")),
  line("рџ’° Kassada qolgan", formatMoney(shiftCashLeft(shift), shift.currency || "UZS")),
  "",
  line("рџ• Yopildi", formatDate(shift.closedAt || new Date())),
  line("рџ“… Sana", formatDate(shift.closedAt || new Date())),
].join("\n");

const orderCancelledMessage = (order = {}) => {
  const firstItem = Array.isArray(order.items) ? order.items[0] : null;

  return [
    "вќЊ Buyurtma bekor qilindi",
    "",
    line("рџ†” Order", orderNumber(order)),
    line("рџЏў Filial", formatBranch(order.branch || order.branchName)),
    line("рџ‘¤ Klient", order.clientName || order.client),
    line("рџ”ђ Yacheyka", formatLockerNumber(firstItem?.lockerNumber || firstItem?.locker?.number || order.lockerNumber)),
    line("рџ“ќ Sabab", order.cancelReason || order.cancellationReason || order.reason),
    line("рџ‘¤ Bekor qildi", formatAdmin(order.cancelledBy || order.cancelledByName || order.admin || order.createdBy)),
    line("рџ• Vaqt", formatDate(order.cancelledAt || order.updatedAt || order.createdAt)),
  ].join("\n");
};

const delayedBaggageMessage = (order = {}) => {
  const firstItem = Array.isArray(order.items) ? order.items[0] : null;

  return [
    "вљ пёЏ Kechikkan bagaj",
    "",
    line("рџ†” Order", orderNumber(order)),
    line("рџЏў Filial", formatBranch(order.branch || order.branchName)),
    line("рџ‘¤ Klient", order.clientName || order.client),
    line("рџ“ћ Telefon", order.phone),
    line("рџ”ђ Yacheyka", formatLockerNumber(firstItem?.lockerNumber || firstItem?.locker?.number || order.lockerNumber)),
    line("вЏ° Tugashi kerak edi", formatDate(order.plannedCheckOut)),
    line("рџ’° Qo'shimcha hisob", formatMoney(order.overtimeAmount || order.extraCharge || 0, order.currency || "UZS")),
  ].join("\n");
};

const overtimePaymentMessage = (order = {}) => [
  "вЏ° Kechikkan bagaj to'lovi",
  "",
  line("рџЏў Filial", formatBranch(order.branch || order.branchName)),
  line("рџ§ѕ Buyurtma", orderNumber(order)),
  line("рџ‘¤ Mijoz", order.clientName || order.client),
  line("рџ“ћ Telefon", order.phone),
  "",
  line("вЊ› Kechikkan vaqt", `${cleanText(order.overtimeHours || 0)} soat`),
  line("рџ’° Qo'shimcha summa", formatMoney(order.overtimeAmount || order.extraPayment || 0, order.currency || "UZS")),
  line("рџ’і To'lov", formatPayment(order.overtimePaymentType || order.paymentType)),
  "",
  line("рџ‘ЁвЂЌрџ’ј Admin", formatAdmin(order.pickedUpBy || order.admin || order.createdBy)),
  line("рџ“… Sana", formatDateMinute(order.realPickupTime || order.updatedAt || new Date())),
].join("\n");

const debtClosedMessage = (debt = {}) => [
  "вњ… Qarz yopildi",
  "",
  line("рџ†” Order", debt.orderNumber || debt.order?.orderNumber),
  line("рџЏў Filial", formatBranch(debt.branch || debt.branchName)),
  line("рџ‘¤ Klient", debt.clientName || debt.client),
  line("рџ“ћ Telefon", debt.phone),
  line("рџ’° Qarz summa", formatMoney(debt.amount || 0, debt.currency || "UZS")),
  line("рџ’і To'lov", formatPayment(debt.paymentType || debt.payment)),
  line("рџ‘¤ Yopdi", formatAdmin(debt.closedBy || debt.admin || debt.closedByName)),
].join("\n");

const debtPaymentMessage = (debt = {}) => [
  "рџ’і Qarz to'lovi olindi",
  "",
  line("рџ§ѕ Buyurtma", debt.orderNumber || debt.order?.orderNumber),
  line("рџЏў Filial", formatBranch(debt.branch || debt.branchName)),
  line("рџ‘¤ Mijoz", debt.clientName || debt.client),
  line("рџ“ћ Telefon", debt.phone),
  "",
  line("рџ’° Olingan summa", formatMoney(debt.paidAmount ?? debt.amount ?? 0, debt.currency || "UZS")),
  line("рџ“ќ Qarz holati", debt.status === "CLOSED" ? "Yopildi" : "Qisman to'landi"),
  line("рџ’і To'lov", formatPayment(debt.paymentType || debt.payment)),
  "",
  line("рџ‘ЁвЂЌрџ’ј Admin", formatAdmin(debt.closedBy || debt.admin || debt.closedByName)),
  line("рџ“… Sana", formatDateMinute(debt.closedAt || debt.paidAt || new Date())),
].join("\n");

const inkassaMessage = (inkassa = {}) => [
  "рџЏ¦ Inkassa qilindi",
  "",
  line("рџЏў Filial", formatBranch(inkassa.branch || inkassa.branchName)),
  line("рџ‘¤ Kimga", inkassa.receiverName || inkassa.receiver || inkassa.recipient),
  line("рџ’° Summa", formatMoney(inkassa.amount || 0, inkassa.currency || "UZS")),
  line("рџ“ќ Izoh", inkassa.note || inkassa.description),
  line("рџ‘¤ Admin", formatAdmin(inkassa.createdBy || inkassa.admin || inkassa.adminName)),
  line("рџ• Sana", formatDate(inkassa.createdAt || new Date())),
].join("\n");

const expenseMessage = (expense = {}) => [
  "рџ’ё Xarajat qo'shildi",
  "",
  line("рџЏў Filial", formatBranch(expense.branch || expense.branchName)),
  line("рџ“‚ Turi", expense.category || expense.type),
  line("рџ’° Summa", formatMoney(expense.amount || 0, expense.currency || "UZS")),
  line("рџ“ќ Sabab", expense.reason || expense.note || expense.description),
  line("рџ‘¤ Admin", formatAdmin(expense.createdBy || expense.admin || expense.adminName)),
].join("\n");

const orderEditMessage = (order = {}, changes = {}) => {
  const lines = Object.entries(changes || {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `вЂў ${key}: ${cleanText(value)}`);

  return [
    "вњЏпёЏ Buyurtma o'zgartirildi",
    "",
    line("рџ†” Order", orderNumber(order)),
    line("рџЏў Filial", formatBranch(order.branch || order.branchName)),
    line("рџ‘¤ Admin", formatAdmin(order.updatedBy || order.admin || order.createdBy)),
    line("рџ“ќ O'zgargan", lines.length ? lines.join("; ") : "-"),
    line("рџ• Sana", formatDate(order.updatedAt || new Date())),
  ].join("\n");
};

const lockerTransferMessage = (payload = {}, transfer = {}) => [
  "рџ”„ Yacheyka almashtirildi",
  "",
  line("рџЏў Filial", formatBranch(payload.branch || payload.branchName)),
  line("рџ†” Order", payload.orderNumber || payload.order),
  line("Eski", formatLockerNumber(transfer.from?.number || payload.from)),
  line("Yangi", formatLockerNumber(transfer.to?.number || payload.to)),
  line("рџ“ќ Sabab", transfer.reason || payload.reason || payload.note),
  line("рџ‘¤ Admin", formatAdmin(transfer.admin || payload.admin || payload.createdBy)),
].join("\n");

const lockerServiceMessage = (payload = {}) => [
  payload.status === "EMPTY" ? "вњ… Yacheyka servisdan chiqarildi" : "рџ”’ Yacheyka servisga olindi",
  "",
  line("рџЏў Filial", formatBranch(payload.branch || payload.branchName)),
  line("рџ”ђ Yacheyka", formatLockerNumber(payload.locker || payload.lockerNumber)),
  line("рџ“ќ Sabab", payload.reason || payload.note),
  line("рџ‘¤ Admin", formatAdmin(payload.admin || payload.createdBy)),
].join("\n");

module.exports = {
  orderMessage,
  shiftOpenedMessage,
  shiftClosedMessage,
  orderCancelledMessage,
  delayedBaggageMessage,
  overtimePaymentMessage,
  debtClosedMessage,
  debtPaymentMessage,
  inkassaMessage,
  expenseMessage,
  orderEditMessage,
  lockerTransferMessage,
  lockerServiceMessage,
};

