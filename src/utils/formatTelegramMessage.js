const { CURRENCIES, currencyFractionDigits } = require("./money");
const { formatTashkentDateTime } = require("./date");
const { cleanDisplayText, formatAdminName } = require("./displayName");
const { paymentLabel } = require("./payment");

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

const formatPayment = (payment) => paymentLabel(payment, { context: "telegram" });

const formatBranch = (branch) => {
  if (!branch) return "-";
  if (typeof branch === "object") return cleanText(branch.name || branch.title || branch.displayName);
  return cleanText(branch);
};

const formatAdmin = (user, branch = null) => formatAdminName(user, { branch, fallback: "Noma'lum admin" });

const shiftCashLeft = (shift = {}) => shift.systemExpectedCash ?? shift.closingCash ?? 0;
const shiftRegularExpense = (shift = {}) => Math.max(Number(shift.expenseAmount || 0) - Number(shift.salaryAmount || 0), 0);

const formatLockerNumber = (value) => {
  const number = cleanText(value);
  return number === "-" ? "-" : `#${number}`;
};

const orderNumber = (order = {}) => cleanText(order.orderNumber || order.displayId);
const overtimeCurrency = (order = {}) => order.overtimeCurrency || order.currency || "UZS";
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
  ].join("\n") + (order.priceApprovedByName ? `\nChegirma tasdiqlovchisi: ${order.priceApprovedByName}\nSabab: ${order.discountReason || '-'}` : '');
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

const orderCancelledMessage = (order = {}) => [
  "❌ Buyurtma bekor qilindi",
  "",
  line("🏢 Filial", formatBranch(order.branch || order.branchName)),
  line("🧾 Buyurtma", orderNumber(order)),
  line("👤 Mijoz", order.clientName || order.client),
  line("💳 To'lov", formatPayment(order.paymentType)),
  line("💰 Summa", formatMoney(order.cancelledAmount ?? order.realPaidAmount ?? order.finalAmount ?? 0, order.currency)),
  line("👤 Admin", formatAdmin(order.cancelledBy || order.cancelledByName || order.admin || order.createdBy, order.branch || order.branchName)),
  line("📅 Sana", formatDate(order.cancelledAt || order.updatedAt || order.createdAt)),
].join("\n");

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
    line("💰 Qo'shimcha hisob", formatMoney(order.overtimeAmount || order.extraCharge || 0, overtimeCurrency(order))),
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
  line("💰 Qo'shimcha summa", formatMoney(order.overtimeAmount || order.extraPayment || 0, overtimeCurrency(order))),
  line("💳 Asosiy to'lov", formatPayment(order.paymentType)),
  line("💳 Qo'shimcha to'lov", formatPayment(order.overtimePaymentType || order.doplataPaymentType)),
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
  line("👤 Admin", formatAdmin(inkassa.adminName || inkassa.admin || inkassa.createdBy, inkassa.branch || inkassa.branchName)),
  line("🕘 Sana", formatDate(inkassa.createdAt || new Date())),
].join("\n");

const expenseMessage = (expense = {}) => [
  "💸 Xarajat qo'shildi",
  "",
  line("🏢 Filial", formatBranch(expense.branch || expense.branchName)),
  line("📂 Turi", expense.category || expense.type),
  line("💰 Summa", formatMoney(expense.amount || 0, expense.currency || "UZS")),
  line("📝 Sabab", expense.reason || expense.note || expense.description),
  line("👤 Admin", formatAdmin(expense.adminName || expense.admin || expense.createdBy, expense.branch || expense.branchName)),
].join("\n");

const orderEditMessage = (order = {}, changes = {}) => {
  const lines = Object.entries(changes || {})
    .filter(([, value]) => value && value.old !== value.next && value.next !== undefined)
    .map(([key, value]) => `${cleanText(key)}: ${cleanText(value.old)} → ${cleanText(value.next)}`);

  return [
    "✏️ Buyurtma tahrirlandi",
    "",
    line("🏢 Filial", formatBranch(order.branch || order.branchName)),
    line("🧾 Buyurtma", orderNumber(order)),
    line("👤 Mijoz", order.clientName || order.client),
    "",
    line("🔄 O'zgargan ma'lumot", lines.length ? lines.join("\n") : "-"),
    "",
    line("👤 Admin", formatAdmin(order.updatedBy || order.admin || order.createdBy, order.branch || order.branchName)),
    line("📅 Sana", formatDate(order.updatedAt || new Date())),
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
  const analytics = shift.shiftAnalytics || null;
  const revenue = analytics?.revenue || null;
  const revenueByCurrency = shift.revenueByCurrency || report.revenueByCurrency || {};
  const cash = shift.cashByCurrency || report.cashByCurrency || {};
  const terminal = shift.terminalByCurrency || report.terminalByCurrency || {};
  const click = shift.clickByCurrency || report.clickByCurrency || {};
  const payme = shift.paymeByCurrency || report.paymeByCurrency || {};
  const hasUnknownRates = revenue
    ? Boolean(revenue.hasUnknownRates)
    : CURRENCIES.some((currency) => currency !== "UZS" && Number(revenueByCurrency[currency] || 0) !== 0);
  const totalUzs = Number(revenue?.totalUzs ?? revenueByCurrency.UZS ?? shift.totalRevenue ?? 0);
  const cashUzs = Number(revenue?.cashUzs ?? cash.UZS ?? 0);
  const terminalUzs = Number(revenue?.terminalUzs ?? terminal.UZS ?? 0);
  const paymeUzs = Number(revenue?.paymeUzs ?? payme.UZS ?? 0);
  const clickUzs = Number(revenue?.clickUzs ?? click.UZS ?? 0);
  const otherUzs = Number(revenue?.otherUzs ?? 0);
  const foreign = revenue?.foreign || CURRENCIES
    .filter((currency) => currency !== "UZS" && Number(revenueByCurrency[currency] || 0) !== 0)
    .map((currency) => ({ currency, amountMinor: Number(revenueByCurrency[currency]), uzs: 0, missingMinor: Number(revenueByCurrency[currency]) }));
  const foreignLines = foreign.flatMap((item) => {
    const minor = Number(item.amountMinor || 0);
    const missing = Number(item.missingMinor || 0);
    const known = minor - missing;
    const values = [];
    if (known !== 0 || Number(item.uzs || 0) !== 0) {
      values.push(`${compactForeignMoney(known, item.currency)} → ${formatMoney(item.uzs, "UZS")}`);
    }
    if (missing !== 0) values.push(`${compactForeignMoney(missing, item.currency)} (kurs yo'q)`);
    return values;
  });
  const hasAmount = (map) => CURRENCIES.some((currency) => Number(map?.[currency] || 0) !== 0);
  const expenses = shift.expenseByCurrency || report.expenseByCurrency || {};
  const salaries = shift.salaryByCurrency || report.salaryByCurrency || {};
  const inkassa = shift.inkassaByCurrency || report.inkassaByCurrency || {};
  const debts = shift.debtByCurrency || report.debtByCurrency || {};
  const cashBalance = shift.cashBalanceByCurrency || report.cashBalanceByCurrency
    || shift.closingCashByCurrency || { UZS: shift.closingCash ?? shift.systemExpectedCash ?? 0 };
  const shortTime = (value) => {
    const date = formatDateMinute(value);
    const match = date.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2})$/);
    return match ? { day: `${match[1]}.${match[2]}.${match[3]}`, time: match[4] } : { day: date, time: "" };
  };
  const opened = shortTime(shift.openedAt || shift.createdAt);
  const closed = shortTime(shift.closedAt || new Date());
  const timeRange = opened.day === closed.day
    ? `${opened.day}, ${opened.time}–${closed.time}`
    : `${opened.day} ${opened.time} → ${closed.day} ${closed.time}`;
  const operator = shift.acceptedByName
    || formatAdmin(shift.openedBy || shift.admin || shift.openedByName, shift.branch || shift.branchName);
  const extrema = (item) => item ? `${item.number} — ${formatMoney(item.amountUzs, "UZS")}` : null;
  const lines = [
    "✅ Smena yopildi",
    `🏢 ${formatBranch(shift.branch || shift.branchName)} | 👤 ${cleanText(operator)}`,
    `🕒 ${timeRange}`,
    "",
    `💰 Jami tushum: ${formatMoney(totalUzs, "UZS")}`,
    `💵 Naqd: ${formatMoney(cashUzs, "UZS")} | 💳 Terminal: ${formatMoney(terminalUzs, "UZS")}`,
    ...foreignLines.map((value, index) => `${index === 0 ? "💱 Valyuta: " : "   "}${value}`),
    ...(paymeUzs !== 0 || clickUzs !== 0
      ? [`🟢 Payme: ${formatMoney(paymeUzs, "UZS")} | 🔵 Click: ${formatMoney(clickUzs, "UZS")}`]
      : []),
    ...(otherUzs ? [`Boshqa to'lovlar: ${formatMoney(otherUzs, "UZS")}`] : []),
    ...(hasUnknownRates ? ["⚠️ Kursi yo'q valyutalar jamiga kiritilmadi"] : []),
    `💼 Kassada qolgan: ${formatCurrencyMap(cashBalance)}`,
  ];
  if (analytics) {
    lines.push(
      "",
      `📦 Buyurtmalar: ${analytics.received} qabul | ${analytics.pickups} topshirildi`,
      ...(extrema(analytics.highest) ? [`🏆 Eng qimmat: ${extrema(analytics.highest)}`] : []),
      ...(extrema(analytics.lowest) ? [`🔻 Eng arzon: ${extrema(analytics.lowest)}`] : []),
      ...(analytics.additionalPayments || analytics.cancellations
        ? [`➕ Qo'shimcha: ${formatMoney(analytics.additionalTotal?.totalUzs || 0, "UZS")} (${analytics.additionalPayments} ta) | ❌ Bekor: ${analytics.cancellations}`]
        : []),
      ...(analytics.additionalTotal?.hasUnknownRates ? ["⚠️ Qo'shimcha to'lovlarda kurs topilmadi"] : []),
      `⏰ Kechikkan: ${analytics.delayed} | 🧳 S:${analytics.sizes.S} M:${analytics.sizes.M} L:${analytics.sizes.L} XL:${analytics.sizes.XL}`,
      ...(analytics.comparisonPercent == null
        ? []
        : [`📈 Oldingi smenaga: ${analytics.comparisonPercent > 0 ? "+" : ""}${analytics.comparisonPercent}%`]),
      ...(analytics.missingTariffs ? [`⚠️ ${analytics.missingTariffs} ta buyurtmaning tarifi noma'lum`] : []),
    );
  } else {
    lines.push("", `📦 Buyurtmalar: ${Number(shift.ordersCount || 0)} ta`);
  }
  if (hasAmount(expenses) || hasAmount(salaries)) {
    lines.push(`💸 Xarajatlar: ${formatCurrencyMap(expenses)}${hasAmount(salaries) ? ` (shundan oylik: ${formatCurrencyMap(salaries)})` : ""}`);
  }
  if (hasAmount(inkassa)) lines.push(`🏦 Inkassa: ${formatCurrencyMap(inkassa)}`);
  if (hasAmount(debts)) lines.push(`📝 Ochiq qarz: ${formatCurrencyMap(debts)}`);
  return lines.join("\n");
};

const overtimePaymentMessageV2 = (order = {}) => [
  "⚠️ Qo'shimcha to'lov",
  "",
  line("🏢 Filial", formatBranch(order.branch || order.branchName)),
  line("🧾 Buyurtma", orderNumber(order)),
  line("👤 Mijoz", order.clientName || order.client),
  line("⏰ Kechikkan vaqt", `${cleanText(order.overtimeHours || 0)} soat`),
  line("💰 Summa", formatMoney(order.overtimeAmount || order.extraPayment || 0, overtimeCurrency(order))),
  line("💳 Asosiy to'lov", formatPayment(order.paymentType)),
  line("💳 Qo'shimcha to'lov", formatPayment(order.overtimePaymentType || order.doplataPaymentType)),
  line("👤 Admin", formatAdmin(order.shiftOpenedBy || order.cashierAdmin || order.pickedUpBy || order.admin || order.createdBy, order.branch || order.branchName)),
].join("\n");

const salesCurrencySymbols = { USD: "$", RUB: "₽", EUR: "€", TJS: "TJS", KZT: "₸" };
const compactForeignMoney = (minor, currency) => {
  const digits = currencyFractionDigits[currency] ?? 2;
  const major = Number(minor || 0) / 10 ** digits;
  const amount = new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(major).replace(/[\u00a0\u202f]/g, " ");
  const symbol = salesCurrencySymbols[currency] || currency;
  return currency === "TJS" ? `${amount} ${symbol}` : `${amount}${symbol}`;
};

const shiftSalesSnapshotMessage = (shift = {}) => {
  const report = shift.report || {};
  const revenue = shift.revenueByCurrency || report.revenueByCurrency || {};
  const cash = shift.cashByCurrency || report.cashByCurrency || {};
  const terminal = shift.terminalByCurrency || report.terminalByCurrency || {};
  const payme = shift.paymeByCurrency || report.paymeByCurrency || {};
  const click = shift.clickByCurrency || report.clickByCurrency || {};
  // Historic callers without a movement-level breakdown can still render,
  // but never silently convert currencies without a stored exchange rate.
  const foreign = CURRENCIES.filter((currency) => currency !== "UZS" && Number(revenue[currency] || 0) !== 0)
    .map((currency) => ({ currency, amountMinor: Number(revenue[currency]), uzs: 0, missingMinor: Number(revenue[currency]) }));
  const summary = shift.telegramSalesSummary || report.telegramSalesSummary || {
    totalUzs: Number(revenue.UZS || 0),
    cashUzs: Number(cash.UZS || 0),
    terminalUzs: Number(terminal.UZS || 0),
    paymeUzs: Number(payme.UZS || 0),
    clickUzs: Number(click.UZS || 0),
    foreign,
    hasUnknownRates: foreign.length > 0,
    otherUzs: 0,
  };

  const foreignLines = (summary.foreign || []).flatMap((item) => {
    const amountMinor = Number(item.amountMinor || 0);
    const unknown = Number(item.missingMinor || 0);
    const known = amountMinor - unknown;
    const lines = [];
    if (known !== 0 || Number(item.uzs || 0) !== 0) {
      lines.push(`${compactForeignMoney(known, item.currency)} - ${formatMoney(item.uzs, "UZS")}`);
    }
    if (unknown !== 0) {
      lines.push(`${compactForeignMoney(unknown, item.currency)} - kurs topilmadi`);
    }
    return lines;
  });
  const hasUnknownRates = Boolean(summary.hasUnknownRates);
  const nonCash = Number(summary.otherUzs || 0);
  return [
    "📊 Savdo hisoboti",
    "",
    `💰 Jami tushum: ${formatMoney(summary.totalUzs || 0, "UZS")}${hasUnknownRates ? " (ayirboshlash kursi yetishmaydi, jami to'liq emas)" : ""}`,
    "",
    `💵 Naqd pul: ${formatMoney(summary.cashUzs || 0, "UZS")}`,
    "",
    "💱 Chet el valyutasidagi to'lovlar:",
    ...(foreignLines.length ? foreignLines : ["To'lov yo'q"]),
    "",
    `💳 Terminal orqali: ${formatMoney(summary.terminalUzs || 0, "UZS")}`,
    `🟢 Payme orqali: ${formatMoney(summary.paymeUzs || 0, "UZS")}`,
    `🔵 Click orqali: ${formatMoney(summary.clickUzs || 0, "UZS")}`,
    ...(nonCash ? [`Boshqa to'lovlar: ${formatMoney(nonCash, "UZS")}`] : []),
  ].join("\n");
};

module.exports = {
  formatMoney,
  formatCurrencyMap,
  orderMessage,
  shiftOpenedMessage: shiftOpenedMessageV2,
  shiftClosedMessage: shiftClosedMessageV2,
  shiftSalesSnapshotMessage,
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
