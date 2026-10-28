const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRateProvider, minorToUzs, normalizeCbuRecord } = require("../src/services/cbuFx.service");

const date = new Date("2026-10-28T12:00:00.000Z");
const rows = ["USD", "EUR", "RUB", "TJS", "KZT"].map((Ccy) => ({
  Ccy, Rate: Ccy === "RUB" ? "141.25" : "12000", Nominal: "1", Date: "28.10.2026",
}));

test("CBU exchange rate is authoritative; RUB minor units convert to UZS exactly", async () => {
  let calls = 0;
  const provider = createRateProvider({ now: () => date, fetchRates: async () => { calls++; return rows; } });
  const first = await provider.getRate("RUB");
  const second = await provider.getRate("USD");
  assert.equal(first.rate, "141.25");
  assert.equal(first.effectiveDate, "2026-10-28");
  assert.equal(minorToUzs(10000, "RUB", first.rate), "14125"); // 100.00 RUB
  assert.equal(minorToUzs(10001, "RUB", first.rate), "14126"); // 100.01 RUB rounds half-up
  assert.equal(calls, 1); // once per Tashkent calendar day
  assert.equal(second.source, "CBU");
});

test("nominal is applied to each quoted currency", () => {
  const record = normalizeCbuRecord({ Ccy: "KZT", Rate: "300", Nominal: "10", Date: "28.10.2026" }, "2026-10-28");
  assert.equal(record.rate, "30");
});

test("foreign payments fail closed if CBU cannot be reached", async () => {
  const provider = createRateProvider({ now: () => date, fetchRates: async () => { throw Error("CBU timeout"); } });
  await assert.rejects(provider.getRate("RUB"), /CBU timeout/);
  assert.equal((await provider.getRate("UZS")).rate, "1");
});

test("reject future, invalid and missing FX rates", async () => {
  assert.throws(() => normalizeCbuRecord({ Ccy:"RUB", Rate:"89", Nominal:"1", Date:"29.10.2026" }, "2026-10-28"));
  const provider = createRateProvider({now: () => date, fetchRates: async () => [{Ccy:"RUB",Rate:"89",Nominal:"1",Date:"28.10.2026"}]});
  await assert.rejects(provider.getRate("RUB"), /lacks a required currency/);
});
