const { CURRENCIES, currencyFractionDigits } = require("./money");
const { formatTashkentDateTime } = require("./date");
const { cleanDisplayText, formatAdminName } = require("./displayName");

const safe = (value, fallback = "-") => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  return value;
};

const cleanText = (value, fallback = "-") => cleanDisplayText(safe(value, fallback), fallback);

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

const formatCurrencyMap = (values = {}) => {
  const formatted = CURRENCIES
    .filter((currency) => Number(values?.[currency] || 0) !== 0)
    .map((currency) => formatMoney(values[currency], currency));
  return formatted.length ? formatted.join(" / ") : formatMoney(0, "UZS");
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
    case "TERMINAL":
    case "TRANSFER":
      return "Terminal";
    case "CLICK":
      return "Click";
    case "PAYME":
      return "Payme";
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

const formatAdmin = (user, branch = null) => formatAdminName(user, { branch });

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
  const sizeLabel = { S: "Kichik", M: "O'rta", L: "Katta", XL: "Juda katta" };
  const sizeCounts = items.reduce((acc, item) => {
    const size = sizeLabel[item.size] || cleanText(item.size);
    if (!size || size === "-") return acc;
    acc[size] = (acc[size] || 0) + Number(item.count || 1);
    return acc;
  }, {});
  const sizes = Object.entries(sizeCounts).map(([size, count]) => `${size}: ${count} ta`);
  const count = Object.values(sizeCounts).reduce((total, value) => total + value, 0) || Number(order.count || 0);

  return [
    "📦 Yangi bagaj qabul qilindi",
    "",
    line("🏢 Filial", formatBranch(order.branch || order.branchName)),
    line("👤 Mijoz", order.clientName || order.client),
    line("📞 Telefon", order.phone),
    line("🪪 Passport", order.passport),
    "",
    line("🧳 O'lcham", sizes.join(", ") || "-"),
    line("🔢 Soni", `${count} ta`),
    "",
    line("🕒 Qabul vaqti", formatDate(order.checkIn || order.createdAt)),
    line("🕘 Olib ketish vaqti", formatDate(order.plannedCheckOut)),
    "",
    line("💳 To'lov", formatPayment(order.paymentType)),
    line("💰 Summa", formatMoney(order.realPaidAmount || order.finalAmount || 0, order.currency)),
    "",
    line("🆔 Buyurtma", orderNumber(order)),
    line("📅 Sana", formatDate(order.createdAt || order.checkIn)),
  ].join("\n");
};

const shiftOpenedMessage = (shift = {}) => [
  "🟢 Kassa ochildi",
  "",
  line("🏢 Filial", formatBranch(shift.branch || shift.branchName)),
  line("👤 Admin", formatAdmin(shift.openedBy || shift.admin || shift.openedByName, shift.branch || shift.branchName)),
  ...(shift.shiftTime ? [line("🕘 Smena", shift.shiftTime), ""] : [""]),
  line("🕒 Ochildi", formatDate(shift.openedAt || shift.createdAt)),
  line("💵 Boshlang'ich kassa", formatMoney(shift.openingCash || 0, shift.currency || "UZS")),
  line("💰 Qabul qilingan", formatMoney(shift.acceptedCash || 0, shift.currency || "UZS")),
  line("📅 Sana", formatDate(shift.openedAt || shift.createdAt)),
].join("\n");

const shiftClosedMessage = (shift = {}) => [
  "🔴 Smena yopildi",
  "",
  line("🏢 Filial", formatBranch(shift.branch || shift.branchName)),
  line("👤 Topshirgan", formatAdmin(shift.openedBy || shift.admin || shift.openedByName, shift.branch || shift.branchName)),
  line("👤 Yopgan", formatAdmin(shift.closedBy || shift.closedByName, shift.branch || shift.branchName)),
  ...(shift.shiftTime ? [line("🕘 Smena", shift.shiftTime)] : []),
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
    line("🆔 Buyurtma", orderNumber(order)),
    line("🏢 Filial", formatBranch(order.branch || order.branchName)),
    line("👤 Mijoz", order.clientName || order.client),
    line("🔐 Yacheyka", formatLockerNumber(firstItem?.lockerNumber || firstItem?.locker?.number || order.lockerNumber)),
    line("📝 Sabab", order.cancelReason || order.cancellationReason || order.reason),
    line("👤 Bekor qildi", formatAdmin(order.cancelledBy || order.cancelledByName || order.admin || order.createdBy, order.branch || order.branchName)),
    line("🕘 Vaqt", formatDate(order.cancelledAt || order.updatedAt || order.createdAt)),
  ].join("\n");
};

const delayedBaggageMessage = (order = {}) => {
  const firstItem = Array.isArray(order.items) ? order.items[0] : null;

  return [
    "⚠️ Kechikkan bagaj",
    "",
    line("🆔 Buyurtma", orderNumber(order)),
    line("🏢 Filial", formatBranch(order.branch || order.branchName)),
    line("👤 Mijoz", order.clientName || order.client),
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
  line("👨‍💼 Admin", formatAdmin(order.shiftOpenedBy || order.cashierAdmin || order.pickedUpBy || order.admin || order.createdBy, order.branch || order.branchName)),
  line("📅 Sana", formatDateMinute(order.realPickupTime || order.updatedAt || new Date())),
].join("\n");

const debtClosedMessage = (debt = {}) => [
  "✅ Qarz yopildi",
  "",
  line("🆔 Buyurtma", debt.orderNumber || debt.order?.orderNumber),
  line("🏢 Filial", formatBranch(debt.branch || debt.branchName)),
  line("👤 Mijoz", debt.clientName || debt.client),
  line("📞 Telefon", debt.phone),
  line("💰 Qarz summa", formatMoney(debt.amount || 0, debt.currency || "UZS")),
  line("💳 To'lov", formatPayment(debt.paymentType || debt.payment)),
  line("👤 Yopdi", formatAdmin(debt.closedBy || debt.admin || debt.closedByName, debt.branch || debt.branchName)),
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
  line("👨‍💼 Admin", formatAdmin(debt.closedBy || debt.admin || debt.closedByName, debt.branch || debt.branchName)),
  line("📅 Sana", formatDateMinute(debt.closedAt || debt.paidAt || new Date())),
].join("\n");

const inkassaMessage = (inkassa = {}) => [
  "🏦 Inkassa qilindi",
  "",
  line("🏢 Filial", formatBranch(inkassa.branch || inkassa.branchName)),
  line("👤 Kimga", inkassa.receiverName || inkassa.receiver || inkassa.recipient),
  line("💰 Summa", formatMoney(inkassa.amount || 0, inkassa.currency || "UZS")),
  line("📝 Izoh", inkassa.note || inkassa.description),
  line("👤 Admin", formatAdmin(inkassa.createdBy || inkassa.admin || inkassa.adminName, inkassa.branch || inkassa.branchName)),
  line("🕘 Sana", formatDate(inkassa.createdAt || new Date())),
].join("\n");

const expenseMessage = (expense = {}) => [
  "💸 Xarajat qo'shildi",
  "",
  line("🏢 Filial", formatBranch(expense.branch || expense.branchName)),
  line("📂 Turi", expense.category || expense.type),
  line("💰 Summa", formatMoney(expense.amount || 0, expense.currency || "UZS")),
  line("📝 Sabab", expense.reason || expense.note || expense.description),
  line("👤 Admin", formatAdmin(expense.createdBy || expense.admin || expense.adminName, expense.branch || expense.branchName)),
].join("\n");

const orderEditMessage = (order = {}, changes = {}) => {
  const lines = Object.entries(changes || {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `• ${key}: ${cleanText(value)}`);

  return [
    "✏️ Buyurtma o'zgartirildi",
    "",
    line("🆔 Buyurtma", orderNumber(order)),
    line("🏢 Filial", formatBranch(order.branch || order.branchName)),
    line("👤 Admin", formatAdmin(order.updatedBy || order.admin || order.createdBy, order.branch || order.branchName)),
    line("📝 O'zgargan", lines.length ? lines.join("; ") : "-"),
    line("🕘 Sana", formatDate(order.updatedAt || new Date())),
  ].join("\n");
};

const lockerTransferMessage = (payload = {}, transfer = {}) => [
  "🔄 Yacheyka almashtirildi",
  "",
  line("🏢 Filial", formatBranch(payload.branch || payload.branchName)),
  line("🆔 Buyurtma", payload.orderNumber || payload.order),
  line("Eski yacheyka", formatLockerNumber(transfer.from?.number || payload.from)),
  line("Yangi yacheyka", formatLockerNumber(transfer.to?.number || payload.to)),
  line("📝 Sabab", transfer.reason || payload.reason || payload.note),
  line("👤 Admin", formatAdmin(transfer.admin || payload.admin || payload.createdBy, payload.branch || payload.branchName)),
].join("\n");

const lockerServiceMessage = (payload = {}) => [
  payload.status === "EMPTY" ? "✅ Yacheyka servisdan chiqarildi" : "🔒 Yacheyka servisga olindi",
  "",
  line("🏢 Filial", formatBranch(payload.branch || payload.branchName)),
  line("🔐 Yacheyka", formatLockerNumber(payload.locker || payload.lockerNumber)),
  line("📝 Sabab", payload.reason || payload.note),
  line("👤 Admin", formatAdmin(payload.admin || payload.createdBy, payload.branch || payload.branchName)),
].join("\n");

const shiftOpenedMessageV2 = (shift = {}) => [
  "🟢 Kassa ochildi",
  "",
  line("🏢 Filial", formatBranch(shift.branch || shift.branchName)),
  "",
  line("👤 Kim topshirdi", shift.acceptedFromName || shift.receivedFrom),
  line("👤 Kim qabul qildi", shift.acceptedByName || formatAdmin(shift.openedBy || shift.admin || shift.openedByName, shift.branch || shift.branchName)),
  "",
  line("💼 Boshlang'ich kassa", formatCurrencyMap(shift.openingCashByCurrency || { UZS: shift.openingCash || 0 })),
  line("🤝 Qabul qilingan", formatCurrencyMap(shift.acceptedCashByCurrency || { UZS: shift.acceptedCash || 0 })),
  ...(shift.shiftTime ? ["", line("Smena", shift.shiftTime)] : []),
  line("🕒 Ochildi", formatDate(shift.openedAt || shift.createdAt)),
].join("\n");

const shiftClosedMessageV2 = (shift = {}) => {
  const report = shift.report || {};
  return [
  "🔴 Smena yopildi",
  "",
  line("🏢 Filial", formatBranch(shift.branch || shift.branchName)),
  "",
  line("👤 Kim topshirdi", shift.acceptedByName || formatAdmin(shift.openedBy || shift.admin || shift.openedByName, shift.branch || shift.branchName)),
  line("👤 Kim qabul qildi", shift.handoverToName || shift.handoverTo || formatAdmin(shift.closedBy || shift.closedByName, shift.branch || shift.branchName)),
  line("👤 Yopgan admin", formatAdmin(shift.closedBy || shift.closedByName, shift.branch || shift.branchName)),
  "",
  line("💼 Boshlang'ich kassa", formatCurrencyMap(shift.openingCashByCurrency || report.openingCashByCurrency)),
  line("🤝 Qabul qilingan", formatCurrencyMap(shift.acceptedCashByCurrency || report.acceptedCashByCurrency)),
  ...(shift.shiftTime ? ["", line("Smena", shift.shiftTime)] : []),
  "",
  line("📦 Buyurtmalar", `${Number(shift.ordersCount || shift.orders || 0)} ta`),
  line("💰 Umumiy tushum", formatCurrencyMap(shift.revenueByCurrency || report.revenueByCurrency)),
  line("💵 Naqd", formatCurrencyMap(shift.cashByCurrency || report.cashByCurrency)),
  line("💳 Terminal", formatCurrencyMap(shift.terminalByCurrency || report.terminalByCurrency)),
  line("🔵 Click", formatCurrencyMap(shift.clickByCurrency || report.clickByCurrency)),
  line("🟢 Payme", formatCurrencyMap(shift.paymeByCurrency || report.paymeByCurrency)),
  "",
  line("💸 Xarajat", formatCurrencyMap(shift.expenseByCurrency || report.expenseByCurrency)),
  line("👛 Oylik", formatCurrencyMap(shift.salaryByCurrency || report.salaryByCurrency)),
  ...(shift.salaryReceiver ? [line("Oylik kimga", shift.salaryReceiver)] : []),
  line("🏦 Inkassa", formatCurrencyMap(shift.inkassaByCurrency || report.inkassaByCurrency)),
  line("📝 Ochiq qarz", formatCurrencyMap(shift.debtByCurrency || report.debtByCurrency)),
  line("💼 Kassada qolgan", formatCurrencyMap(shift.cashBalanceByCurrency || report.cashBalanceByCurrency)),
  "",
  line("🕒 Yopildi", formatDate(shift.closedAt || new Date())),
].join("\n");
};

const overtimePaymentMessageV2 = (order = {}) => [
  "⚠️ Qo'shimcha to'lov",
  "",
  line("🏢 Filial", formatBranch(order.branch || order.branchName)),
  line("🧾 Buyurtma", orderNumber(order)),
  line("👤 Mijoz", order.clientName || order.client),
  line("⏰ Kechikkan vaqt", `${cleanText(order.overtimeHours || 0)} soat`),
  line("💰 Summa", formatMoney(order.overtimeAmount || order.extraPayment || 0, order.currency || "UZS")),
  line("👤 Admin", formatAdmin(order.shiftOpenedBy || order.cashierAdmin || order.pickedUpBy || order.admin || order.createdBy, order.branch || order.branchName)),
].join("\n");

module.exports = {
  formatMoney,
  formatCurrencyMap,
  orderMessage,
  shiftOpenedMessage: shiftOpenedMessageV2,
  shiftClosedMessage: shiftClosedMessageV2,
  orderCancelledMessage,
  delayedBaggageMessage,
  overtimePaymentMessage: overtimePaymentMessageV2,
  debtClosedMessage,
  debtPaymentMessage,
  inkassaMessage,
  expenseMessage,
  orderEditMessage,
  lockerTransferMessage,
  lockerServiceMessage,
};
