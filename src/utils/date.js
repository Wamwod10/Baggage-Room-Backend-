const { AppError } = require("./response");

const TASHKENT_TIME_ZONE = "Asia/Tashkent";
const TASHKENT_OFFSET_MINUTES = 5 * 60;

const pad = (value, length = 2) => String(value).padStart(length, "0");

const localTashkentToUtc = (year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) =>
  new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - TASHKENT_OFFSET_MINUTES * 60 * 1000);

const parseLocalParts = (value) => {
  const match = String(value).match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/,
  );
  if (!match) return null;
  const [, year, month, day, hour = "00", minute = "00", second = "00", millisecond = "0"] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    millisecond: Number(millisecond.padEnd(3, "0")),
    dateOnly: !match[4],
  };
};

const hasExplicitTimezone = (value) => /[T\s].*(Z|[+-]\d{2}:?\d{2})$/i.test(String(value));

const parseDate = (value, field = "date", boundary = "exact") => {
  if (!value) return undefined;
  const localParts = parseLocalParts(value);
  let date;

  if (localParts && !hasExplicitTimezone(value)) {
    const endOfDay = boundary === "end" && localParts.dateOnly;
    date = localTashkentToUtc(
      localParts.year,
      localParts.month,
      localParts.day,
      endOfDay ? 23 : localParts.hour,
      endOfDay ? 59 : localParts.minute,
      endOfDay ? 59 : localParts.second,
      endOfDay ? 999 : localParts.millisecond,
    );
  } else {
    date = new Date(value);
  }

  if (Number.isNaN(date.getTime())) throw new AppError(`Invalid ${field}`, 400);
  return date;
};

const dateRangeWhere = (dateFrom, dateTo, field = "createdAt") => {
  const from = parseDate(dateFrom, "dateFrom", "start");
  const to = parseDate(dateTo, "dateTo", "end");
  if (!from && !to) return {};
  return {
    [field]: {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    },
  };
};

const addHours = (date, hours) => new Date(new Date(date).getTime() + Number(hours) * 60 * 60 * 1000);

const getTashkentParts = (date = new Date()) => {
  const shifted = new Date(new Date(date).getTime() + TASHKENT_OFFSET_MINUTES * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
};

const formatTashkentDateKey = (date = new Date()) => {
  const parts = getTashkentParts(date);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
};

const formatTashkentDateTime = (date = new Date()) => {
  const parsed = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(parsed.getTime())) return "-";
  const parts = getTashkentParts(parsed);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
};

const formatTashkentIso = (date = new Date()) => {
  const parsed = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${formatTashkentDateTime(parsed).replace(" ", "T")}+05:00`;
};

const startOfToday = () => {
  const parts = getTashkentParts(new Date());
  return localTashkentToUtc(parts.year, parts.month, parts.day);
};

module.exports = {
  TASHKENT_TIME_ZONE,
  parseDate,
  dateRangeWhere,
  addHours,
  startOfToday,
  formatTashkentDateKey,
  formatTashkentDateTime,
  formatTashkentIso,
  getTashkentParts,
  localTashkentToUtc,
};
