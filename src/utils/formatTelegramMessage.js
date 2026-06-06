const { currencyFractionDigits } = require("./money");

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
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "-";
  const pad = (v) => String(v).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

const formatLockerNumber = (value) => {
  const number = cleanText(value);
  return number === "-" ? "-" : `№${number}`;
};

const orderNumber = (order = {}) => cleanText(order.orderNumber || order.displayId);

const orderMessage = (order = {}) => {
  const items = Array.isArray(order.items) ? order.items : [];
  const lockerLines = items.map((item) => {
    const locker = formatLockerNumber(item.lockerNumber || item.locker?.number);
    const size = cleanText(item.size);
    const price = formatMoney(item.finalPrice || item.finalAmount || 0, item.currency || order.currency);
    return `• ${locker} | ${size} | ${price}`;
  });

  return [
    "🧳 Yangi bagaj qabul qilindi",
    "",
    `🧾 Buyurtma:\n${orderNumber(order)}`,
    "",
    `🏢 Filial:\n${formatBranch(order.branch || order.branchName)}`,
    "",
    `👤 Admin:\n${formatAdmin(order.createdBy || order.admin)}`,
    "",
    `👥 Mijoz:\n${cleanText(order.clientName || order.client)}`,
    "",
    `☎️ Telefon:\n${cleanText(order.phone)}`,
    "",
    lockerLines.length ? ["🔐 Yacheykalar:", ...lockerLines].join("\n") : null,
    "",
    `📦 Jami:\n${items.length || Number(order.count || 0)} ta bagaj`,
    "",
    `⏳ Tarif:\n${cleanText(order.tariffHours || order.customHours)} soat`,
    "",
    `💰 Narx:\n${formatMoney(order.calculatedAmount || 0, order.currency)}`,
    "",
    `🎁 Chegirma:\n${formatMoney(order.discountAmount || 0, order.currency)}`,
    "",
    `💵 Yakuniy:\n${formatMoney(order.finalAmount || 0, order.currency)}`,
    "",
    `💳 To'lov:\n${formatPayment(order.paymentType)}`,
    "",
    `🕘 Qabul:\n${formatDate(order.checkIn || order.createdAt)}`,
    "",
    `🕘 Tugash:\n${formatDate(order.plannedCheckOut)}`,
  ]
    .filter(Boolean)
    .join("\n");
};

const shiftOpenedMessage = (shift = {}) => [
  "🟢 Kassa ochildi",
  "",
  `🏢 Filial:\n${formatBranch(shift.branch || shift.branchName)}`,
  "",
  `👤 Admin:\n${formatAdmin(shift.openedBy || shift.admin || shift.openedByName)}`,
  "",
  `💵 Boshlang'ich kassa:\n${formatMoney(shift.openingCash || 0, shift.currency || "UZS")}`,
  "",
  `💰 Oldingi smenadan qabul:\n${formatMoney(shift.acceptedCash || 0, shift.currency || "UZS")}`,
  "",
  `🕘 Ochildi:\n${formatDate(shift.openedAt || shift.createdAt)}`,
].join("\n");

const shiftClosedMessage = (shift = {}) => [
  "🔴 Smena yopildi",
  "",
  `🏢 Filial:\n${formatBranch(shift.branch || shift.branchName)}`,
  "",
  `👤 Topshirgan:\n${formatAdmin(shift.openedBy || shift.admin || shift.openedByName)}`,
  "",
  `👤 Yopgan:\n${formatAdmin(shift.closedBy || shift.closedByName)}`,
  "",
  "::::::::::::::::::::::::",
  "",
  `📦 Buyurtmalar:\n${Number(shift.ordersCount || shift.orders || 0)} ta`,
  "",
  `💰 Umumiy tushum:\n${formatMoney(shift.totalRevenue || 0, shift.currency || "UZS")}`,
  "",
  `💵 Naqd:\n${formatMoney(shift.cashRevenue || 0, shift.currency || "UZS")}`,
  "",
  `💳 Karta:\n${formatMoney(shift.cardRevenue || 0, shift.currency || "UZS")}`,
  "",
  `🏦 O'tkazma:\n${formatMoney(shift.transferRevenue || 0, shift.currency || "UZS")}`,
  "",
  "::::::::::::::::::::::::",
  "",
  `💸 Xarajat:\n${formatMoney(shift.expenseAmount || 0, shift.currency || "UZS")}`,
  "",
  `🏦 Inkassa:\n${formatMoney(shift.inkassaAmount || 0, shift.currency || "UZS")}`,
  "",
  `📝 Ochiq qarz:\n${formatMoney(shift.debtAmount || 0, shift.currency || "UZS")}`,
  "",
  "::::::::::::::::::::::::",
  "",
  `💰 Kassada qolgan:\n${formatMoney(shift.closingCash || shift.systemExpectedCash || 0, shift.currency || "UZS")}`,
  "",
  `🕘 Yopildi:\n${formatDate(shift.closedAt || new Date())}`,
].join("\n");

const orderCancelledMessage = (order = {}) => {
  const firstItem = Array.isArray(order.items) ? order.items[0] : null;

  return [
    "❌ Buyurtma bekor qilindi",
    "",
    `🧾 Buyurtma:\n${orderNumber(order)}`,
    "",
    `🏢 Filial:\n${formatBranch(order.branch || order.branchName)}`,
    "",
    `👥 Mijoz:\n${cleanText(order.clientName || order.client)}`,
    "",
    `🔐 Yacheyka:\n${formatLockerNumber(firstItem?.lockerNumber || firstItem?.locker?.number || order.lockerNumber)}`,
    "",
    `📝 Sabab:\n${cleanText(order.cancelReason || order.cancellationReason || order.reason)}`,
    "",
    `👤 Bekor qildi:\n${formatAdmin(order.cancelledBy || order.cancelledByName || order.admin || order.createdBy)}`,
    "",
    `🕘 Vaqt:\n${formatDate(order.cancelledAt || order.updatedAt || order.createdAt)}`,
  ].join("\n");
};

const delayedBaggageMessage = (order = {}) => {
  const firstItem = Array.isArray(order.items) ? order.items[0] : null;

  return [
    "⚠️ Kechikkan bagaj",
    "",
    `🧾 Buyurtma:\n${orderNumber(order)}`,
    "",
    `🏢 Filial:\n${formatBranch(order.branch || order.branchName)}`,
    "",
    `👥 Mijoz:\n${cleanText(order.clientName || order.client)}`,
    "",
    `☎️ Telefon:\n${cleanText(order.phone)}`,
    "",
    `🔐 Yacheyka:\n${formatLockerNumber(firstItem?.lockerNumber || firstItem?.locker?.number || order.lockerNumber)}`,
    "",
    `⏰ Tugashi kerak edi:\n${formatDate(order.plannedCheckOut)}`,
    "",
    `💰 Qo'shimcha hisob:\n${formatMoney(order.overtimeAmount || order.extraCharge || 0, order.currency || "UZS")}`,
  ].join("\n");
};

const overtimePaymentMessage = (order = {}) => [
  "⏰ Overtime to'lovi",
  "",
  `🧾 Buyurtma:\n${orderNumber(order)}`,
  "",
  `🏢 Filial:\n${formatBranch(order.branch || order.branchName)}`,
  "",
  `👥 Mijoz:\n${cleanText(order.clientName || order.client)}`,
  "",
  `⌛ Ortiqcha vaqt:\n${cleanText(order.overtimeHours || 0)} soat`,
  "",
  `💵 To'landi:\n${formatMoney(order.overtimeAmount || 0, order.currency || "UZS")}`,
  "",
  `💳 To'lov:\n${formatPayment(order.overtimePaymentType || order.paymentType)}`,
  "",
  `👤 Admin:\n${formatAdmin(order.pickedUpBy || order.admin || order.createdBy)}`,
].join("\n");

const debtClosedMessage = (debt = {}) => [
  "✅ Qarz yopildi",
  "",
  `🧾 Buyurtma:\n${cleanText(debt.orderNumber || debt.order?.orderNumber)}`,
  "",
  `🏢 Filial:\n${formatBranch(debt.branch || debt.branchName)}`,
  "",
  `👥 Mijoz:\n${cleanText(debt.clientName || debt.client)}`,
  "",
  `☎️ Telefon:\n${cleanText(debt.phone)}`,
  "",
  `💰 Qarz summa:\n${formatMoney(debt.amount || 0, debt.currency || "UZS")}`,
  "",
  `💳 To'lov:\n${formatPayment(debt.paymentType || debt.payment)}`,
  "",
  `👤 Yopdi:\n${formatAdmin(debt.closedBy || debt.admin || debt.closedByName)}`,
].join("\n");

const inkassaMessage = (inkassa = {}) => [
  "🏦 Inkassa qilindi",
  "",
  `🏢 Filial:\n${formatBranch(inkassa.branch || inkassa.branchName)}`,
  "",
  `👤 Kimga:\n${cleanText(inkassa.receiverName || inkassa.receiver || inkassa.recipient)}`,
  "",
  `💰 Summa:\n${formatMoney(inkassa.amount || 0, inkassa.currency || "UZS")}`,
  "",
  `📝 Izoh:\n${cleanText(inkassa.note || inkassa.description)}`,
  "",
  `👤 Admin:\n${formatAdmin(inkassa.createdBy || inkassa.admin || inkassa.adminName)}`,
  "",
  `🕘 Sana:\n${formatDate(inkassa.createdAt || new Date())}`,
].join("\n");

const expenseMessage = (expense = {}) => [
  "💸 Xarajat qo'shildi",
  "",
  `🏢 Filial:\n${formatBranch(expense.branch || expense.branchName)}`,
  "",
  `📂 Turi:\n${cleanText(expense.category || expense.type)}`,
  "",
  `💰 Summa:\n${formatMoney(expense.amount || 0, expense.currency || "UZS")}`,
  "",
  `📝 Sabab:\n${cleanText(expense.reason || expense.note || expense.description)}`,
  "",
  `👤 Admin:\n${formatAdmin(expense.createdBy || expense.admin || expense.adminName)}`,
].join("\n");

const orderEditMessage = (order = {}, changes = {}) => {
  const lines = Object.entries(changes || {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `• ${key}: ${cleanText(value)}`);

  return [
    "✏️ Buyurtma o'zgartirildi",
    "",
    `🧾 Buyurtma:\n${orderNumber(order)}`,
    "",
    `🏢 Filial:\n${formatBranch(order.branch || order.branchName)}`,
    "",
    `👤 Admin:\n${formatAdmin(order.updatedBy || order.admin || order.createdBy)}`,
    "",
    `O'zgargan:\n${lines.length ? lines.join("\n") : "-"}`,
    "",
    `🕘 Sana:\n${formatDate(order.updatedAt || new Date())}`,
  ].join("\n");
};

const lockerTransferMessage = (payload = {}, transfer = {}) => [
  "🔄 Yacheyka almashtirildi",
  "",
  `🏢 Filial:\n${formatBranch(payload.branch || payload.branchName)}`,
  "",
  `🧾 Buyurtma:\n${cleanText(payload.orderNumber || payload.order)}`,
  "",
  `Eski:\n${formatLockerNumber(transfer.from?.number || payload.from)}`,
  "",
  `Yangi:\n${formatLockerNumber(transfer.to?.number || payload.to)}`,
  "",
  `📝 Sabab:\n${cleanText(transfer.reason || payload.reason || payload.note)}`,
  "",
  `👤 Admin:\n${formatAdmin(transfer.admin || payload.admin || payload.createdBy)}`,
].join("\n");

const lockerServiceMessage = (payload = {}) => [
  payload.status === "EMPTY" ? "✅ Yacheyka servisdan chiqarildi" : "🔒 Yacheyka servisga olindi",
  "",
  `🏢 Filial:\n${formatBranch(payload.branch || payload.branchName)}`,
  "",
  `🔐 Yacheyka:\n${formatLockerNumber(payload.locker || payload.lockerNumber)}`,
  "",
  `📝 Sabab:\n${cleanText(payload.reason || payload.note)}`,
  "",
  `👤 Admin:\n${formatAdmin(payload.admin || payload.createdBy)}`,
].join("\n");

module.exports = {
  orderMessage,
  shiftOpenedMessage,
  shiftClosedMessage,
  orderCancelledMessage,
  delayedBaggageMessage,
  overtimePaymentMessage,
  debtClosedMessage,
  inkassaMessage,
  expenseMessage,
  orderEditMessage,
  lockerTransferMessage,
  lockerServiceMessage,
};
