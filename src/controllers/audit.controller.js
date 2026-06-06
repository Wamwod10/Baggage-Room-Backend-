const auditService = require("../services/audit.service");
const { success, asyncHandler } = require("../utils/response");

const list = asyncHandler(async (req, res) => success(res, await auditService.listAuditLogs(req.user, req.query)));

module.exports = { list };
