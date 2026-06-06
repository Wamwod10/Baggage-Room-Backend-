const { formatCurrency: formatCurrencyRaw, currencyFractionDigits } = require("./money");

const safe = (value, fallback = "-") => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  return value;
};

const isLikelyId = (s = "") => {
  if (typeof s !== "string") return false;
  const trimmed = s.trim();
  if (trimmed.length >= 8 && !/\s/.test(trimmed) && /^[A-Za-z0-9\-_]+$/.test(trimmed)) return true;
  return false;
};

const formatCurrency = (amount, currency = "UZS") => {
  try {
    const raw = formatCurrencyRaw(amount, currency, "uz-UZ");
    if ((currency || "").toUpperCase() === "UZS") {
      return raw.replace(/UZS/i, "so'm");
    }
    return raw;
  } catch {
    const digits = currencyFractionDigits[currency] ?? 2;
    const major = Number(amount || 0) / 10 ** digits;
    const num = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(major);
    return `${num} ${currency}`;
  }
};

const formatMoney = (amount, currency = "UZS") => {
  try {
    return formatCurrency(amount, currency);
  } catch {
    return `${Number(amount || 0).toLocaleString("ru-RU")} ${currency}`;
  }
};

const formatDate = (date) => {
  if (!date) return "-";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "-";
  const pad = (v) => String(v).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const formatPayment = (payment) => {
  if (!payment) return "-";
  const p = String(payment).toLowerCase();
  if (p.includes("cash") || p.includes("naqd")) return "Naqd 💵";
  if (p.includes("card") || p.includes("karta") || p.includes("terminal")) return "Karta 💳";
  if (p.includes("transfer") || p.includes("o'") || p.includes("otkaz") || p.includes("o'tkaz")) return "O'tkazma 🏦";
  if (p.includes("debt") || p.includes("qarz")) return "Qarz 📝";
  return "-";
};

const formatBranch = (branch) => {
  if (!branch) return "-";
  if (typeof branch === "object") return safe(branch.name || branch.title || branch.displayName, "-");
  if (typeof branch === "string") {
    if (isLikelyId(branch)) return "-";
    return branch;
  }
  return "-";
};

const formatAdmin = (user) => {
  if (!user) return "-";
  if (typeof user === "string") return user;
  return safe(user.fullName || user.name || user.login || user.adminName, "-");
};

const orderMessage = (order = {}) => {
  const orderNumber = safe(order.orderNumber || order.displayId || "-");
  const branch = formatBranch(order.branch || order.branchName || order.branchId);
  const admin = order.createdBy ? formatAdmin(order.createdBy) : formatAdmin(order.admin);
  const client = safe(order.clientName || order.client || "-");
  const phone = safe(order.phone || "-");
  const items = Array.isArray(order.items) ? order.items : [];

  const lockerLines = items.length
    ? items.map((it) => `• №${safe(it.lockerNumber || it.locker?.number || it.lockerId)} | ${safe(it.size)} | ${formatMoney(it.finalPrice || it.finalAmount || it.finalPrice, it.currency || order.currency)}`)
    : [];

  const totalCount = items.length || safe(order.count || 0, 0);
  const tariff = safe(order.tariffHours || order.customHours || order.tariff || "-");
  const basePrice = formatMoney(order.calculatedAmount || order.originalPrice || order.finalPrice, order.currency);
  const discount = formatMoney(order.discountAmount || order.discount || 0, order.currency);
  const final = formatMoney(order.finalAmount || order.realPaidAmount || order.finalPrice, order.currency);
  const payment = formatPayment(order.paymentType || order.payment || order.payMethod);
  const checkIn = formatDate(order.checkIn || order.createdAt);
  const checkOut = formatDate(order.plannedCheckOut || order.checkOut || order.plannedCheckOut);

  return [
    "🧳 Yangi bagaj qabul qilindi",
    "",
    `🧾 Buyurtma:\n${orderNumber}`,
    "",
    `🏢 Filial:\n${branch}`,
    "",
    `👨‍💼 Admin:\n${admin}`,
    "",
    `👤 Mijoz:\n${client}`,
    "",
    `📞 Telefon:\n${phone}`,
    "",
    lockerLines.length ? ["🔐 Yacheykalar:", ...lockerLines].join("\n") : null,
    "",
    `📦 Jami:\n${totalCount} ta bagaj`,
    "",
    `⏳ Tarif:\n${tariff} soat`,
    "",
    `💰 Narx:\n${basePrice}`,
    "",
    `🎁 Chegirma:\n${discount}`,
    "",
    `💵 Yakuniy:\n${final}`,
    "",
    `💳 To'lov:\n${payment}`,
    "",
    `🕒 Qabul:\n${checkIn}`,
    "",
    `🕘 Tugash:\n${checkOut}`,
  ]
    .filter(Boolean)
    .join("\n");
};

const shiftOpenedMessage = (shift = {}) => {
  const branch = formatBranch(shift.branch || shift.branchName || shift.branchId);
  const admin = formatAdmin(shift.openedBy || shift.admin || shift.openedByName);
  const openingCash = formatMoney(shift.openingCash || shift.acceptedCash || 0, shift.currency || "UZS");
  const accepted = formatMoney(shift.acceptedCash || shift.acceptedAmount || 0, shift.currency || "UZS");
  const openedAt = formatDate(shift.openedAt || shift.createdAt);

  return [
    "🟢 Kassa ochildi",
    "",
    `🏢 Filial:\n${branch}`,
    "",
    `👨‍💼 Admin:\n${admin}`,
    "",
    `💵 Boshlang'ich kassa:\n${openingCash}`,
    "",
    `💰 Oldingi smenadan qabul:\n${accepted}`,
    "",
    `🕘 Ochilgan vaqt:\n${openedAt}`,
  ].join("\n");
};

const shiftClosedMessage = (shift = {}) => {
  const branch = formatBranch(shift.branch || shift.branchName || shift.branchId);
  const closedBy = formatAdmin(shift.closedBy || shift.closedByName || shift.handoverToName || shift.handoverTo);
  const openedBy = formatAdmin(shift.openedBy || shift.admin || shift.openedByName);
  const orders = safe(shift.report?.orders || shift.ordersCount || shift.orders || 0, 0);
  const totalRevenue = formatMoney(shift.totalRevenue || shift.report?.totalRevenue || 0, shift.currency || "UZS");
  const cash = formatMoney(shift.cashRevenue || shift.report?.cashRevenue || 0, shift.currency || "UZS");
  const card = formatMoney(shift.cardRevenue || shift.report?.cardRevenue || 0, shift.currency || "UZS");
  const transfer = formatMoney(shift.transferRevenue || shift.report?.transferRevenue || 0, shift.currency || "UZS");
  const expense = formatMoney(shift.expenseAmount || shift.report?.expenseAmount || 0, shift.currency || "UZS");
  const inkassa = formatMoney(shift.inkassaAmount || shift.report?.inkassaAmount || 0, shift.currency || "UZS");
  const debt = formatMoney(shift.debtAmount || shift.report?.debtAmount || 0, shift.currency || "UZS");
  const cashLeft = formatMoney(shift.closingCash || shift.cashLeft || shift.report?.systemExpectedCash || 0, shift.currency || "UZS");
  const shiftTime = `${shift.shiftTime || "-"}`;

  return [
    "🔴 Smena yopildi",
    "",
    `🏢 Filial:\n${branch}`,
    "",
    `👨‍💼 Topshirgan:\n${openedBy}`,
    "",
    `👤 Qabul qiluvchi:\n${closedBy}`,
    "",
    "::::::::::::::::::::::::",
    "",
    `📦 Buyurtmalar:\n${orders} ta`,
    "",
    `💰 Umumiy savdo:\n${totalRevenue}`,
    "",
    `💵 Naqd:\n${cash}`,
    "",
    `💳 Karta:\n${card}`,
    "",
    `🏦 O'tkazma:\n${transfer}`,
    "",
    "::::::::::::::::::::::::",
    "",
    `💸 Xarajat:\n${expense}`,
    "",
    `🏦 Inkassa:\n${inkassa}`,
    "",
    `📝 Qarz:\n${debt}`,
    "",
    "::::::::::::::::::::::::",
    "",
    `💰 Kassada qolgan:\n${cashLeft}`,
    "",
    `🕘 Smena vaqti:\n${shiftTime}`,
  ].join("\n");
};

const orderCancelledMessage = (order = {}) => {
  const orderNumber = safe(order.orderNumber || order.displayId || "-");
  const branch = formatBranch(order.branch || order.branchName || order.branchId);
  const client = safe(order.clientName || order.client || "-");
  const locker = (order.items && order.items[0]) ? `№${order.items[0].lockerNumber || order.items[0].locker?.number}` : (order.lockerNumber ? `№${order.lockerNumber}` : "-");
  const reason = safe(order.cancelReason || order.cancellationReason || order.reason || "-");
  const admin = formatAdmin(order.cancelledBy || order.cancelledByName || order.admin || order.createdBy);
  const time = formatDate(order.cancelledAt || order.updatedAt || order.createdAt);

  return [
    "❌ Buyurtma bekor qilindi",
    "",
    `🧾 Buyurtma:\n${orderNumber}`,
    "",
    `🏢 Filial:\n${branch}`,
    "",
    `👤 Mijoz:\n${client}`,
    "",
    `🔐 Yacheyka:\n${locker}`,
    "",
    `📝 Sabab:\n${reason}`,
    "",
    `👨‍💼 Bekor qildi:\n${admin}`,
    "",
    `🕒 Vaqt:\n${time}`,
  ].join("\n");
};

const delayedBaggageMessage = (order = {}) => {
  const orderNumber = safe(order.orderNumber || order.displayId || "-");
  const branch = formatBranch(order.branch || order.branchName || order.branchId);
  const client = safe(order.clientName || order.client || "-");
  const phone = safe(order.phone || "-");
  const locker = (order.items && order.items[0]) ? `№${order.items[0].lockerNumber || order.items[0].locker?.number}` : "-";
  const planned = formatDate(order.plannedCheckOut || order.checkOut);
  const diffHours = order.delayHours || order.delay || "-";
  const extra = formatMoney(order.overtimeAmount || order.extraCharge || 0, order.currency || "UZS");

  return [
    "⚠️ Kechikkan bagaj!",
    "",
    `🧾 Buyurtma:\n${orderNumber}`,
    "",
    `🏢 Filial:\n${branch}`,
    "",
    `👤 Mijoz:\n${client}`,
    "",
    `📞 Telefon:\n${phone}`,
    "",
    `🔐 Yacheyka:\n${locker}`,
    "",
    `⏰ Tugashi kerak edi:\n${planned}`,
    "",
    `⌛ Kechikdi:\n${diffHours} soat`,
    "",
    `💰 Qo'shimcha hisob:\n${extra}`,
  ].join("\n");
};

const overtimePaymentMessage = (order = {}) => {
  const orderNumber = safe(order.orderNumber || order.displayId || "-");
  const client = safe(order.clientName || order.client || "-");
  const hours = safe(order.overtimeHours || order.extraHours || "-");
  const amount = formatMoney(order.overtimeAmount || order.amount || 0, order.currency || "UZS");
  const payment = formatPayment(order.paymentType || order.payment);
  const admin = formatAdmin(order.pickedUpBy || order.admin || order.createdBy);

  return [
    "⏰ Qo'shimcha vaqt to'lovi",
    "",
    `🧾 Buyurtma:\n${orderNumber}`,
    "",
    `👤 Mijoz:\n${client}`,
    "",
    `⌛ Ortiqcha vaqt:\n${hours} soat`,
    "",
    `💵 To'landi:\n${amount}`,
    "",
    `💳 To'lov:\n${payment}`,
    "",
    `👨‍💼 Admin:\n${admin}`,
  ].join("\n");
};

const debtClosedMessage = (debt = {}) => {
  const orderNumber = safe(debt.orderNumber || debt.order?.orderNumber || "-");
  const client = safe(debt.clientName || debt.client || "-");
  const phone = safe(debt.phone || "-");
  const amount = formatMoney(debt.amount || 0, debt.currency || "UZS");
  const payment = formatPayment(debt.paymentType || debt.payment);
  const admin = formatAdmin(debt.closedBy || debt.admin || debt.closedByName);

  return [
    "✅ Qarz yopildi",
    "",
    `🧾 Buyurtma:\n${orderNumber}`,
    "",
    `👤 Mijoz:\n${client}`,
    "",
    `📞 Telefon:\n${phone}`,
    "",
    `💰 Qarz summa:\n${amount}`,
    "",
    `💳 To'lov:\n${payment}`,
    "",
    `👨‍💼 Yopdi:\n${admin}`,
  ].join("\n");
};

const inkassaMessage = (inkassa = {}) => {
  const branch = formatBranch(inkassa.branch || inkassa.branchName || inkassa.branchId);
  const to = safe(inkassa.receiverName || inkassa.receiver || inkassa.recipient || inkassa.handoverTo);
  const amount = formatMoney(inkassa.amount || 0, inkassa.currency || "UZS");
  const note = safe(inkassa.note || inkassa.description || "-");
  const admin = formatAdmin(inkassa.createdBy || inkassa.admin || inkassa.adminName || inkassa.createdById);
  const date = formatDate(inkassa.createdAt || inkassa.createdAt || new Date());

  return [
    "🏦 Inkassa qilindi",
    "",
    `🏢 Filial:\n${branch}`,
    "",
    `👤 Kimga:\n${to}`,
    "",
    `💰 Summa:\n${amount}`,
    "",
    `📝 Izoh:\n${note}`,
    "",
    `👨‍💼 Admin:\n${admin}`,
    "",
    `🕒 Sana:\n${date}`,
  ].join("\n");
};

const expenseMessage = (expense = {}) => {
  const branch = formatBranch(expense.branch || expense.branchName || expense.branchId);
  const category = safe(expense.category || expense.type || "-");
  const amount = formatMoney(expense.amount || 0, expense.currency || "UZS");
  const reason = safe(expense.note || expense.reason || expense.description || "-");
  const admin = formatAdmin(expense.createdBy || expense.admin || expense.adminName);

  return [
    "💸 Xarajat qo'shildi",
    "",
    `🏢 Filial:\n${branch}`,
    "",
    `📂 Turi:\n${category}`,
    "",
    `💰 Summa:\n${amount}`,
    "",
    `📝 Sabab:\n${reason}`,
    "",
    `👨‍💼 Admin:\n${admin}`,
  ].join("\n");
};

const orderEditMessage = (order = {}, changes = {}) => {
  const orderNumber = safe(order.orderNumber || order.displayId || "-");
  const admin = formatAdmin(order.updatedBy || order.admin || order.createdBy);
  const changesLines = Object.entries(changes || {}).map(([k, v]) => `${k}: ${safe(v)}`).join("\n") || "-";
  const time = formatDate(order.updatedAt || new Date());

  return [
    "✏️ Buyurtma o'zgartirildi",
    "",
    `🧾 Buyurtma:\n${orderNumber}`,
    "",
    `👨‍💼 Admin:\n${admin}`,
    "",
    `O'zgargan:\n${changesLines}`,
    "",
    `🕒 Sana:\n${time}`,
  ].join("\n");
};

const lockerTransferMessage = (payload = {}, transfer = {}) => {
  const branch = formatBranch(payload.branch || payload.branchName || payload.branchId);
  const orderNumber = safe(payload.orderNumber || payload.order || "-");
  const from = transfer.from ? `№${transfer.from.number} ${transfer.from.size || ""}` : transfer.from;
  const to = transfer.to ? `№${transfer.to.number} ${transfer.to.size || ""}` : transfer.to;
  const reason = safe(transfer.reason || payload.reason || "-");
  const admin = formatAdmin(transfer.admin || payload.admin || payload.createdBy);

  return [
    "🔄 Yacheyka almashtirildi",
    "",
    `🏢 Filial:\n${branch}`,
    "",
    `🧾 Buyurtma:\n${orderNumber}`,
    "",
    `Eski:\n${from}`,
    "",
    `Yangi:\n${to}`,
    "",
    `📝 Sabab:\n${reason}`,
    "",
    `👨‍💼 Admin:\n${admin}`,
  ].join("\n");
};

const lockerServiceMessage = (payload = {}) => {
  const branch = formatBranch(payload.branch || payload.branchName || payload.branchId);
  const locker = payload.locker ? `№${payload.locker}` : payload.lockerId ? `№${payload.lockerId}` : "-";
  const reason = safe(payload.reason || payload.note || "-");
  const admin = formatAdmin(payload.admin || payload.createdBy);

  return [
    "🔒 Yacheyka servisga olindi",
    "",
    `🏢 Filial:\n${branch}`,
    "",
    `🔐 Yacheyka:\n${locker}`,
    "",
    `📝 Sabab:\n${reason}`,
    "",
    `👨‍💼 Admin:\n${admin}`,
  ].join("\n");
};

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
