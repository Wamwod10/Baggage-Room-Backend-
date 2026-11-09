// Dependency-free, searchable A4 landscape PDF for management-only monthly sales archives.
// Old cash movement data is never modified. Monetary amounts stay in their own currencies.
const { AppError } = require("../utils/response");
const { formatTashkentDateTime } = require("../utils/date");
const orderService = require("./order.service");

const PAGE_W = 842;
const PAGE_H = 595;
const ROWS_PER_PAGE = 21;
const MONTH_PATTERN = /^(20[0-9]{2})-(0[1-9]|1[0-2])$/;
const COLUMNS = [
  { title: "#", x: 29, chars: 4 },
  { title: "Sana", x: 52, chars: 14 },
  { title: "Buyurtma", x: 135, chars: 16 },
  { title: "Filial", x: 223, chars: 15 },
  { title: "Mijoz / telefon", x: 313, chars: 19 },
  { title: "Bagaj", x: 426, chars: 14 },
  { title: "Holat", x: 507, chars: 15 },
  { title: "Tolov turi", x: 592, chars: 13 },
  { title: "Tarif UZS", x: 669, chars: 13 },
  { title: "Tolov", x: 745, chars: 18 },
];
const TRANSLIT = Object.freeze({
  А:"A",Б:"B",В:"V",Г:"G",Д:"D",Е:"E",Ё:"Yo",Ж:"J",З:"Z",И:"I",Й:"Y",К:"K",Л:"L",М:"M",
  Н:"N",О:"O",П:"P",Р:"R",С:"S",Т:"T",У:"U",Ф:"F",Х:"X",Ц:"Ts",Ч:"Ch",Ш:"Sh",Щ:"Sh",
  Ъ:"",Ы:"I",Ь:"",Э:"E",Ю:"Yu",Я:"Ya",Ў:"O'",Қ:"Q",Ғ:"G'",Ҳ:"H",
  а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"yo",ж:"j",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",
  н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"x",ц:"ts",ч:"ch",ш:"sh",щ:"sh",
  ъ:"",ы:"i",ь:"",э:"e",ю:"yu",я:"ya",ў:"o'",қ:"q",ғ:"g'",ҳ:"h",
  "\u2018":"'", "\u2019":"'", "\u02bb":"'", "\u02bc":"'", "\u2013":"-", "\u2014":"-", "\u00a0":" ",
});
const latin = (value) => Array.from(String(value ?? ""))
  .map((ch) => TRANSLIT[ch] ?? ch.normalize("NFKD").replace(/[\u0300-\u036f]/g, ""))
  .join("").replace(/[^\x20-\x7e]/g, "?").replace(/\s+/g, " ").trim();
const pdfEscape = (value) => latin(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const money = (amount, currency = "UZS") => {
  const minor = Number(amount || 0);
  const digits = currency === "UZS" ? 0 : 2;
  const n = Number.isFinite(minor) ? minor / 10 ** digits : 0;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace(/,/g, " ");
};
const STATUS = { ACTIVE:"Aktiv", DELAYED:"Kechikkan", PICKED_UP:"Yopilgan", CANCELLED:"Bekor qilingan" };
const PAYMENT = { CASH:"Naqd", CARD:"Karta", TERMINAL:"Terminal", CLICK:"Click", PAYME:"Payme", TRANSFER:"Otkazma", DEBT:"Qarz" };
const cell = (value, chars) => {
  const v = latin(value);
  return v.length <= chars ? v : v.slice(0, Math.max(0, chars - 2)) + "..";
};
const monthRangeTashkent = (month) => {
  const match = MONTH_PATTERN.exec(month || "");
  if (!match) throw new AppError("Oy YYYY-MM formatida bolishi kerak", 400);
  const y = Number(match[1]), m = Number(match[2]);
  return {
    dateFrom: new Date(Date.UTC(y, m - 1, 1, -5)).toISOString(),
    dateTo: new Date(Date.UTC(y, m, 1, -5) - 1).toISOString(),
  };
};

// Using the original order's native currency instead of mixing USD, RUB, TJS and UZS.
const summarize = (orders) => orders.reduce((acc, order) => {
  const c = order.currency || "UZS";
  acc[c] = (acc[c] || 0) + Number(order.realPaidAmount || 0);
  return acc;
}, {});

const pdfText = (x, top, value, size = 8.2, bold = false, color = "0.17 0.22 0.32") =>
  `BT /${bold ? "F2" : "F1"} ${size} Tf ${color} rg 1 0 0 1 ${x} ${PAGE_H - top} Tm (${pdfEscape(value)}) Tj ET\n`;
const pdfRect = (x, top, width, height, color) =>
  `${color} rg ${x} ${PAGE_H - top - height} ${width} ${height} re f\n`;
const pdfLine = (x1, top, x2, color = "0.86 0.89 0.93") =>
  `${color} RG 0.5 w ${x1} ${PAGE_H - top} m ${x2} ${PAGE_H - top} l S\n`;
const rowDetail = (order, index) => {
  const date = formatTashkentDateTime(order.createdAt || order.checkIn).slice(5, 16);
  const names = order.clientName || "";
  const lockers = (order.items || []).map((item) => `${item.size || "?"}x${item.count || 1} #${item.lockerNumber || "-"}`).join(" ");
  const currency = order.currency || "UZS";
  return {
    first: [
      index + 1, date, order.orderNumber, order.branch?.name || order.branchId || "",
      names, lockers, STATUS[order.status] || order.status,
      PAYMENT[order.paymentType] || order.paymentType,
      order.calculatedAmountUZS == null ? "-" : money(order.calculatedAmountUZS, "UZS"),
      `${money(order.realPaidAmount, currency)} ${currency}`,
    ],
    phone: order.phone || "",
  };
};
const drawPage = ({ orders, month, branch, totals, page, pages, offset, now }) => {
  let out = pdfRect(0, 0, PAGE_W, 71, "0.08 0.16 0.29");
  out += pdfText(28, 28, "QONOQ BAGGAGE  /  SAVDO TARIXI", 16, true, "1 1 1");
  out += pdfText(29, 49, `Oy: ${month}   Filial: ${branch}`, 10.5, false, "0.81 0.9 1");
  out += pdfText(28, 92, `Jami buyurtmalar: ${totals.count}    Yuklangan sana: ${now}`, 9.2, true);
  const summary = Object.entries(totals.paid).sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => `${currency}: ${money(amount, currency)}`).join("     ");
  out += pdfText(28, 110, `Buyurtmadagi qayd etilgan tolovlar: ${summary || "0"}`, 8.8);
  out += pdfText(28, 127, "Eslatma: valyutalar aralashtirilmaydi; ushbu hisobot kassa inkassatsiyasi emas.", 8, false, "0.39 0.44 0.53");
  out += pdfRect(26, 140, 790, 23, "0.89 0.93 0.98");
  for (const col of COLUMNS) out += pdfText(col.x, 155, col.title, 8.1, true);
  orders.forEach((order, rowIndex) => {
    const y = 163 + rowIndex * 18.3;
    if (rowIndex % 2 === 1) out += pdfRect(26, y, 790, 18.2, "0.967 0.976 0.989");
    const detail = rowDetail(order, offset + rowIndex);
    COLUMNS.forEach((col, i) => out += pdfText(col.x, y + 12, cell(detail.first[i], col.chars), 7.6, i === 2));
    // Small phone line makes the archive useful without exposing passports.
    if (detail.phone) out += pdfText(313, y + 17, cell(detail.phone, 18), 5.1, false, "0.43 0.47 0.54");
    out += pdfLine(26, y + 18.2, 816);
  });
  out += pdfLine(28, 553, 814);
  out += pdfText(28, 571, "Qonoq Baggage Room | Boshqaruv uchun oylik arxiv | Asia/Tashkent", 8, false, "0.39 0.44 0.53");
  out += pdfText(742, 571, `${page} / ${pages}`, 9, true);
  return out;
};

const buildSalesHistoryPdf = (orders, { month, branch = "Barcha filiallar", now = new Date() } = {}) => {
  monthRangeTashkent(month);
  const all = Array.isArray(orders) ? orders : [];
  const paid = summarize(all);
  const pages = Math.max(1, Math.ceil(all.length / ROWS_PER_PAGE));
  const objects = [null];
  const add = (value) => { objects.push(value); return objects.length - 1; };
  const pagesId = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const kids = [];
  for (let index = 0; index < pages; index++) {
    const slice = all.slice(index * ROWS_PER_PAGE, (index + 1) * ROWS_PER_PAGE);
    const textStream = drawPage({
      orders: slice, month, branch, totals: { count: all.length, paid },
      page: index + 1, pages, offset: index * ROWS_PER_PAGE,
      now: formatTashkentDateTime(now),
    });
    const bytes = Buffer.from(textStream, "ascii");
    const contentId = add(Buffer.concat([
      Buffer.from(`<< /Length ${bytes.length} >>\nstream\n`, "ascii"),
      bytes,
      Buffer.from("endstream", "ascii"),
    ]));
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${contentId} 0 R >>`));
  }
  objects[pagesId] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const parts = [Buffer.from("%PDF-1.4\n%Qonoq archive\n", "ascii")];
  let offset = parts[0].length;
  const offsets = [0];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = offset;
    const body = Buffer.isBuffer(objects[id]) ? objects[id] : Buffer.from(objects[id], "ascii");
    const part = Buffer.concat([Buffer.from(`${id} 0 obj\n`, "ascii"), body, Buffer.from("\nendobj\n", "ascii")]);
    parts.push(part);
    offset += part.length;
  }
  const xref = offset;
  parts.push(Buffer.from(`xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "ascii"));
  return Buffer.concat(parts);
};

const downloadMonthlySalesPdf = async (user, { month, branchId } = {}) => {
  if (user?.role !== "SUPER_ADMIN") throw new AppError("Faqat rahbariyat PDF hisobotini yuklay oladi", 403);
  const { dateFrom, dateTo } = monthRangeTashkent(month);
  const query = { branchId, dateFrom, dateTo, limit: 200, sortBy: "createdAt", sortOrder: "asc" };
  const first = await orderService.listOrders(user, { ...query, page: 1 });
  const total = Number(first.pagination?.total || 0);
  if (total > 20000) throw new AppError("Oy uchun 20000 tadan kop buyurtma. Filialni tanlab yuklang.", 413);
  const orders = [...first.items];
  const count = Math.ceil(total / 200);
  for (let page = 2; page <= count; page++) {
    const result = await orderService.listOrders(user, { ...query, page });
    orders.push(...result.items);
  }
  if (orders.length !== total) throw new AppError("Hisobot vaqtida buyurtmalar ozgardi. Qayta urining.", 409);
  const branch = branchId
    ? (orders[0]?.branch?.name || "Tanlangan filial")
    : "Barcha filiallar";
  return buildSalesHistoryPdf(orders, { month, branch });
};

module.exports = { monthRangeTashkent, buildSalesHistoryPdf, downloadMonthlySalesPdf };
