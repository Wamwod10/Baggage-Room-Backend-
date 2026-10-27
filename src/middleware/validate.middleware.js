const { AppError } = require("../utils/response");

const fieldLabels = {
  "body.amount": "Summa",
  "body.receiverName": "Qabul qiluvchi ism",
  "body.branchId": "Filial",
  "body.reason": "Sabab",
  "body.category": "Kategoriya",
  "body.clientName": "Klient ismi",
  "body.phone": "Telefon",
  "body.items": "Yacheyka",
  "body.lockerIds": "Yacheyka",
  "body.openingCash": "Boshlang'ich kassa",
  "body.closingCash": "Yakuniy kassa",
  "body.botToken": "Bot token",
  "body.groupId": "Group ID",
};

const humanizeValidationMessage = (path, message) => {
  const label = fieldLabels[path] || path.replace(/^body\./, "");
  if (message === "Required") return `${label} majburiy`;
  if (message.includes("Expected") || message.includes("received undefined")) return `${label} majburiy`;
  if (message.includes("Number must be greater than or equal to 0")) return `${label} manfiy bo'lishi mumkin emas`;
  if (message.includes("String must contain at least")) return `${label} to'liq kiritilishi kerak`;
  return message;
};

const validate = (schema, { bodyArrayLimits = {}, bodyObjectLimits = {} } = {}) => (req, _res, next) => {
  for (const [field, limit] of Object.entries(bodyArrayLimits)) {
    if (Array.isArray(req.body?.[field]) && req.body[field].length > limit) {
      const message = `${field} may contain at most ${limit} entries`;
      throw new AppError(message, 400, [{ path: `body.${field}`, message }]);
    }
  }
  for (const [field, limit] of Object.entries(bodyObjectLimits)) {
    const value = req.body?.[field];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      let count = 0;
      for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key) && ++count > limit) {
          const message = `${field} may contain at most ${limit} entries`;
          throw new AppError(message, 400, [{ path: `body.${field}`, message }]);
        }
      }
    }
  }
  const result = schema.safeParse({
    body: req.body,
    query: req.query,
    params: req.params,
  });

  if (!result.success) {
    const errors = result.error.errors.slice(0, 20).map((err) => {
      const path = err.path.map((part) => String(part).slice(0, 256)).join(".").slice(0, 256);
      return { path, message: humanizeValidationMessage(path, err.message).slice(0, 256) };
    });
    throw new AppError(errors[0]?.message || "Ma'lumotlar noto'g'ri kiritilgan", 400, errors);
  }

  req.body = result.data.body || req.body;
  req.query = result.data.query || req.query;
  req.params = result.data.params || req.params;
  req.perfMark?.("validation");
  next();
};

module.exports = validate;
