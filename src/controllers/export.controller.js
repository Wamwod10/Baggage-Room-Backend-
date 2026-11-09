const exportService = require("../services/export.service");
const monthlyPdf = require("../services/monthlySalesPdf.service");
const { success, asyncHandler } = require("../utils/response");

const sendExport = (res, data, filename, format) => {
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
    return res.send(data);
  }
  return success(res, data);
};

const orders = asyncHandler(async (req, res) => sendExport(res, await exportService.exportOrders(req.user, req.query), "orders", req.query.format));
const shifts = asyncHandler(async (req, res) => sendExport(res, await exportService.exportShifts(req.user, req.query), "shifts", req.query.format));
const finance = asyncHandler(async (req, res) => sendExport(res, await exportService.exportFinance(req.user, req.query), "finance", req.query.format));

const monthlySalesPdf = asyncHandler(async (req, res) => {
  const pdf = await monthlyPdf.downloadMonthlySalesPdf(req.user, req.query);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="qonoq-savdo-tarixi-${req.query.month}.pdf"`);
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.send(pdf);
});

module.exports = { orders, shifts, finance, monthlySalesPdf };
