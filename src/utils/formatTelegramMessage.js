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
const shiftRegularExpense = (shift = {}) => Math.max(Number(shift.expenseAmount || 0) - Number(shift.salaryAmount || 0), 0);

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
    "📦 Yangi baggage qabul qilindi",
    "",
    line("🏢 Filial", formatBranch(order.branch || order.branchName)),
    line("👤 Klient", order.clientName || order.client),
    line("📞 Telefon", order.phone),
    line("🪪 Passport", order.passport),
    "",
    line("🧳 Size", sizes.join(", ") || "-"),
    line("🔢 Soni", `${count} ta`),
    "",
    line("🕒 Check-in", formatDate(order.checkIn || order.createdAt)),
    line("🕘 Check-out", formatDate(order.plannedCheckOut)),
    "",
    line("💳 To'lov", formatPayment(order.paymentType)),
    line("💰 Summa", formatMoney(order.realPaidAmount || order.finalAmount || 0, order.currency)),
    "",
    line("🆔 Order", orderNumber(order)),
    line("📅 Sana", formatDate(order.createdAt || order.checkIn)),
  ].join("\n");
};

const shiftOpenedMessage = (shift = {}) => [
  "🟢 Kassa ochildi",
  "",
  line("🏢 Filial", formatBranch(shift.branch || shift.branchName)),
  line("👤 Admin", formatAdmin(shift.openedBy || shift.admin || shift.openedByName)),
  ...(shift.shiftTime ? [line("🕘 Shift", shift.shiftTime), ""] : [""]),
  line("🕒 Ochildi", formatDate(shift.openedAt || shift.createdAt)),
  line("💵 Opening cash", formatMoney(shift.openingCash || 0, shift.currency || "UZS")),
  line("💰 Qabul qilingan", formatMoney(shift.acceptedCash || 0, shift.currency || "UZS")),
  line("📅 Sana", formatDate(shift.openedAt || shift.createdAt)),
].join("\n");

const shiftClosedMessage = (shift = {}) => [
  "🔴 Smena yopildi",
  "",
  line("🏢 Filial", formatBranch(shift.branch || shift.branchName)),
  line("👤 Topshirgan", formatAdmin(shift.openedBy || shift.admin || shift.openedByName)),
  line("👤 Yopgan", formatAdmin(shift.closedBy || shift.closedByName)),
  ...(shift.shiftTime ? [line("🕘 Shift", shift.shiftTime)] : []),
  "",
  line("📦 Buyurtmalar", `${Number(shift.ordersCount || shift.orders || 0)} ta`),
  line("💰 Umumiy tushum", formatMoney(shift.totalRevenue || 0, shift.currency || "UZS")),
  line("💵 Naqd", formatMoney(shift.cashRevenue || 0, shift.currency || "UZS")),
  line("💳 Karta", formatMoney(shift.cardRevenue || 0, shift.currency || "UZS")),
  line("🏦 O'tkazma", formatMoney(shift.transferRevenue || 0, shift.currency || "UZS")),
  "",
  line("💸 Xarajat", formatMoney(shiftRegularExpense(shift), shift.currency || "UZS")),
  line("💵 Oylik", formatMoney(shift.salaryAmount || 0, shift.currency || "UZS")),
  ...(shift.salaryReceiver ? [line("👤 Oylik kimga", shift.salaryReceiver)] : []),
  line("🏦 Inkassa", formatMoney(shift.inkassaAmount || 0, shift.currency || "UZS")),
  line("📝 Ochiq qarz", formatMoney(shift.debtAmount || 0, shift.currency || "UZS")),
  line("💰 Kassada qolgan", formatMoney(shiftCashLeft(shift), shift.currency || "UZS")),
  "",
  line("🕘 Yopildi", formatDate(shift.closedAt || new Date())),
  line("📅 Sana", formatDate(shift.closedAt || new Date())),
].join("\n");

const orderCancelledMessage = (order = {}) => {
  const firstItem = Array.isArray(order.items) ? order.items[0] : null;

  return [
    "❌ Buyurtma bekor qilindi",
    "",
    line("🆔 Order", orderNumber(order)),
    line("🏢 Filial", formatBranch(order.branch || order.branchName)),
    line("👤 Klient", order.clientName || order.client),
    line("🔐 Yacheyka", formatLockerNumber(firstItem?.lockerNumber || firstItem?.locker?.number || order.lockerNumber)),
    line("📝 Sabab", order.cancelReason || order.cancellationReason || order.reason),
    line("👤 Bekor qildi", formatAdmin(order.cancelledBy || order.cancelledByName || order.admin || order.createdBy)),
    line("🕘 Vaqt", formatDate(order.cancelledAt || order.updatedAt || order.createdAt)),
  ].join("\n");
};

const delayedBaggageMessage = (order = {}) => {
  const firstItem = Array.isArray(order.items) ? order.items[0] : null;

  return [
    "⚠️ Kechikkan bagaj",
    "",
    line("🆔 Order", orderNumber(order)),
    line("🏢 Filial", formatBranch(order.branch || order.branchName)),
    line("👤 Klient", order.clientName || order.client),
    line("📞 Telefon", order.phone),
    line("🔐 Yacheyka", formatLockerNumber(firstItem?.lockerNumber || firstItem?.locker?.number || order.lockerNumber)),
    line("⏰ Tugashi kerak edi", formatDate(order.plannedCheckOut)),
    line("💰 Qo'shimcha hisob", formatMoney(order.overtimeAmount || order.extraCharge || 0, order.currency || "UZS")),
  ].join("\n");
};

const overtimePaymentMessage = (order = {}) => [
  "⏰ Kechikkan bagaj to'lovi",
  "",
  line("🏢 Filial", formatBranch(order.branch || order.branchName)),
  line("🧾 Buyurtma", orderNumber(order)),
  line("👤 Mijoz", order.clientName || order.client),
  line("📞 Telefon", order.phone),
  "",
  line("⌛ Kechikkan vaqt", `${cleanText(order.overtimeHours || 0)} soat`),
  line("💰 Qo'shimcha summa", formatMoney(order.overtimeAmount || order.extraPayment || 0, order.currency || "UZS")),
  line("💳 To'lov", formatPayment(order.overtimePaymentType || order.paymentType)),
  "",
  line("👨‍💼 Admin", formatAdmin(order.pickedUpBy || order.admin || order.createdBy)),
  line("📅 Sana", formatDateMinute(order.realPickupTime || order.updatedAt || new Date())),
].join("\n");

const debtClosedMessage = (debt = {}) => [
  "✅ Qarz yopildi",
  "",
  line("🆔 Order", debt.orderNumber || debt.order?.orderNumber),
  line("🏢 Filial", formatBranch(debt.branch || debt.branchName)),
  line("👤 Klient", debt.clientName || debt.client),
  line("📞 Telefon", debt.phone),
  line("💰 Qarz summa", formatMoney(debt.amount || 0, debt.currency || "UZS")),
  line("💳 To'lov", formatPayment(debt.paymentType || debt.payment)),
  line("👤 Yopdi", formatAdmin(debt.closedBy || debt.admin || debt.closedByName)),
].join("\n");

const debtPaymentMessage = (debt = {}) => [
  "💳 Qarz to'lovi olindi",
  "",
  line("🧾 Buyurtma", debt.orderNumber || debt.order?.orderNumber),
  line("🏢 Filial", formatBranch(debt.branch || debt.branchName)),
  line("👤 Mijoz", debt.clientName || debt.client),
  line("📞 Telefon", debt.phone),
  "",
  line("💰 Olingan summa", formatMoney(debt.paidAmount ?? debt.amount ?? 0, debt.currency || "UZS")),
  line("📝 Qarz holati", debt.status === "CLOSED" ? "Yopildi" : "Qisman to'landi"),
  line("💳 To'lov", formatPayment(debt.paymentType || debt.payment)),
  "",
  line("👨‍💼 Admin", formatAdmin(debt.closedBy || debt.admin || debt.closedByName)),
  line("📅 Sana", formatDateMinute(debt.closedAt || debt.paidAt || new Date())),
].join("\n");

const inkassaMessage = (inkassa = {}) => [
  "🏦 Inkassa qilindi",
  "",
  line("🏢 Filial", formatBranch(inkassa.branch || inkassa.branchName)),
  line("👤 Kimga", inkassa.receiverName || inkassa.receiver || inkassa.recipient),
  line("💰 Summa", formatMoney(inkassa.amount || 0, inkassa.currency || "UZS")),
  line("📝 Izoh", inkassa.note || inkassa.description),
  line("👤 Admin", formatAdmin(inkassa.createdBy || inkassa.admin || inkassa.adminName)),
  line("🕘 Sana", formatDate(inkassa.createdAt || new Date())),
].join("\n");

const expenseMessage = (expense = {}) => [
  "💸 Xarajat qo'shildi",
  "",
  line("🏢 Filial", formatBranch(expense.branch || expense.branchName)),
  line("📂 Turi", expense.category || expense.type),
  line("💰 Summa", formatMoney(expense.amount || 0, expense.currency || "UZS")),
  line("📝 Sabab", expense.reason || expense.note || expense.description),
  line("👤 Admin", formatAdmin(expense.createdBy || expense.admin || expense.adminName)),
].join("\n");

const orderEditMessage = (order = {}, changes = {}) => {
  const lines = Object.entries(changes || {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `• ${key}: ${cleanText(value)}`);

  return [
    "✏️ Buyurtma o'zgartirildi",
    "",
    line("🆔 Order", orderNumber(order)),
    line("🏢 Filial", formatBranch(order.branch || order.branchName)),
    line("👤 Admin", formatAdmin(order.updatedBy || order.admin || order.createdBy)),
    line("📝 O'zgargan", lines.length ? lines.join("; ") : "-"),
    line("🕘 Sana", formatDate(order.updatedAt || new Date())),
  ].join("\n");
};

const lockerTransferMessage = (payload = {}, transfer = {}) => [
  "🔄 Yacheyka almashtirildi",
  "",
  line("🏢 Filial", formatBranch(payload.branch || payload.branchName)),
  line("🆔 Order", payload.orderNumber || payload.order),
  line("Eski", formatLockerNumber(transfer.from?.number || payload.from)),
  line("Yangi", formatLockerNumber(transfer.to?.number || payload.to)),
  line("📝 Sabab", transfer.reason || payload.reason || payload.note),
  line("👤 Admin", formatAdmin(transfer.admin || payload.admin || payload.createdBy)),
].join("\n");

const lockerServiceMessage = (payload = {}) => [
  payload.status === "EMPTY" ? "✅ Yacheyka servisdan chiqarildi" : "🔒 Yacheyka servisga olindi",
  "",
  line("🏢 Filial", formatBranch(payload.branch || payload.branchName)),
  line("🔐 Yacheyka", formatLockerNumber(payload.locker || payload.lockerNumber)),
  line("📝 Sabab", payload.reason || payload.note),
  line("👤 Admin", formatAdmin(payload.admin || payload.createdBy)),
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
