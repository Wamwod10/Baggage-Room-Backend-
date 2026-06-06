const success = (res, data = null, statusCode = 200) => {
  return res.status(statusCode).json({ success: true, data });
};

const fail = (res, message = "Something went wrong", statusCode = 500, errors = []) => {
  return res.status(statusCode).json({ success: false, message, errors });
};

class AppError extends Error {
  constructor(message, statusCode = 500, errors = []) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
    this.isOperational = true;
  }
}

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { success, fail, AppError, asyncHandler };
