const exportService = require("../services/export.service");
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

module.exports = { orders, shifts, finance };
