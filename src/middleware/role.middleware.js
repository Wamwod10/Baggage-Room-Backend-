const { AppError } = require("../utils/response");

const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) throw new AppError("Authentication is required", 401);
  if (!roles.includes(req.user.role)) throw new AppError("You do not have permission for this action", 403);
  next();
};

module.exports = { requireRole };
