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

const validate = (schema) => (req, _res, next) => {
  const result = schema.safeParse({
    body: req.body,
    query: req.query,
    params: req.params,
  });

  if (!result.success) {
    const errors = result.error.errors.map((err) => ({
      path: err.path.join("."),
      message: humanizeValidationMessage(err.path.join("."), err.message),
    }));
    throw new AppError(errors[0]?.message || "Ma'lumotlar noto'g'ri kiritilgan", 400, errors);
  }

  req.body = result.data.body || req.body;
  req.query = result.data.query || req.query;
  req.params = result.data.params || req.params;
  next();
};

module.exports = validate;
