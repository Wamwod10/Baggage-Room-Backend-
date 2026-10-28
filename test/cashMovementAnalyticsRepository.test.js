const test = require("node:test");
const assert = require("node:assert/strict");
const { loadMovementFacts } = require("../src/repositories/cashMovementAnalytics.repository");

test("movement analytics are aggregated in SQL without raw notes or customer data", async () => {
  let sql = "";
  const client = {
    $queryRaw: async (query) => {
      sql = query.strings.join("?");
      return [{
        branchId: "branch-a",
        shiftId: "shift-a",
        type: "ORDER_PAYMENT",
        direction: "IN",
        amount: 1500n,
        uzsEquivalent: null,
        missingFxCount: 0,
        currency: "UZS",
        paymentType: "CASH",
        createdById: "user-a",
        day: "2026-09-28",
        isSalary: false,
        count: 3,
      }];
    },
  };

  const rows = await loadMovementFacts({ branchId: "branch-a", dateFrom: "2026-09-28", dateTo: "2026-09-28" }, client);

  assert.deepEqual(rows, [{
    branchId: "branch-a",
    shiftId: "shift-a",
    type: "ORDER_PAYMENT",
    direction: "IN",
    amount: 1500,
    uzsEquivalent: null,
    missingFxCount: 0,
    currency: "UZS",
    paymentType: "CASH",
    createdById: "user-a",
    day: "2026-09-28",
    isSalary: false,
    count: 3,
  }]);
  assert.match(sql, /SUM\(m\."amount"\)/);
  assert.match(sql, /SUM\(m\."uzsEquivalent"\)/);
  assert.match(sql, /AS "missingFxCount"/);
  assert.match(sql, /COUNT\(\*\)/);
  assert.match(sql, /AT TIME ZONE 'UTC' AT TIME ZONE 'Asia\/Tashkent'/);
  assert.doesNotMatch(sql, /m\."note"\s+AS/);
});
