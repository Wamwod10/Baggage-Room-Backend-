const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseDate,
  dateRangeWhere,
  formatTashkentDateKey,
  formatTashkentIso,
  startOfToday,
} = require("../src/utils/date");

test("backend parses Tashkent wall-clock independently of server timezone", () => {
  assert.equal(parseDate("2026-08-26T00:30").toISOString(), "2026-08-25T19:30:00.000Z");
  assert.equal(formatTashkentDateKey("2026-08-25T23:30:00.000Z"), "2026-08-26");
  assert.equal(formatTashkentIso("2026-08-25T19:30:00.000Z"), "2026-08-26T00:30:00+05:00");
});

test("date range boundaries cover one complete Tashkent day", () => {
  const range = dateRangeWhere("2026-08-26", "2026-08-26").createdAt;
  assert.equal(range.gte.toISOString(), "2026-08-25T19:00:00.000Z");
  assert.equal(range.lte.toISOString(), "2026-08-26T18:59:59.999Z");
});

test("startOfToday is a valid UTC instant representing Tashkent midnight", () => {
  const value = startOfToday();
  assert.equal(value.getUTCHours(), 19);
  assert.equal(value.getUTCMinutes(), 0);
});
