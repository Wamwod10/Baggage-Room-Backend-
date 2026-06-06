const { AppError } = require("./response");

const parseDate = (value, field = "date") => {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new AppError(`Invalid ${field}`, 400);
  return date;
};

const dateRangeWhere = (dateFrom, dateTo, field = "createdAt") => {
  const from = parseDate(dateFrom, "dateFrom");
  const to = parseDate(dateTo, "dateTo");
  if (!from && !to) return {};
  return {
    [field]: {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    },
  };
};

const addHours = (date, hours) => new Date(new Date(date).getTime() + Number(hours) * 60 * 60 * 1000);

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

module.exports = { parseDate, dateRangeWhere, addHours, startOfToday };
