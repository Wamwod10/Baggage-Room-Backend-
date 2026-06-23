require("dotenv").config();

const webhook = String(process.env.GOOGLE_SHEET_WEBHOOK || process.env.GOOGLE_SHEETS_WEBHOOK || "").trim();
const branchCode = String(process.env.GOOGLE_SHEETS_TEST_BRANCH || "TIA").trim().toUpperCase();

if (!webhook) throw new Error("GOOGLE_SHEET_WEBHOOK is not configured");

const batch = `GS-MAPPING-TEST-${Date.now()}`;
const createdAt = new Date().toISOString();
const common = { branchCode, createdAt, amountUnit: "MAJOR" };

const order = (name, paymentType, currency, sheetAmount) => ({
  ...common,
  action: "NEW_ORDER",
  entityId: `${batch}:${name}`,
  idempotencyKey: `${batch}:${name}`,
  orderNumber: `${batch}-${name}`,
  clientName: `TEST ${name}`,
  lockers: [{ size: "S", count: 1 }, { size: "M", count: 2 }, { size: "L", count: 1 }],
  period: "3 soat",
  paymentType,
  currency,
  amount: sheetAmount,
  sheetAmount,
});

const cases = [
  ["order-cash-uzs-F", order("CASH-UZS-F", "CASH", "UZS", 250000)],
  ["order-cash-usd-G", order("CASH-USD-G", "CASH", "USD", 123.45)],
  ["order-click-L", order("CLICK-L", "CLICK", "UZS", 1000)],
  ["order-payme-M", order("PAYME-M", "PAYME", "UZS", 2000)],
  ["order-terminal-N", order("TERMINAL-N", "TERMINAL", "UZS", 3000)],
  ["expense-U-V", {
    ...common,
    action: "EXPENSE",
    entityId: `${batch}:EXPENSE-U-V`,
    idempotencyKey: `${batch}:EXPENSE-U-V`,
    adminName: "GS Test Admin",
    category: "Internet",
    reason: "mapping test",
    currency: "UZS",
    amount: 60000,
    expenseAmount: 60000,
    sheetAmount: 60000,
  }],
  ["salary-U-V", {
    ...common,
    action: "SALARY",
    entityId: `${batch}:SALARY-U-V`,
    idempotencyKey: `${batch}:SALARY-U-V`,
    salaryReceiver: "GS Test Employee",
    currency: "UZS",
    amount: 70000,
    salaryAmount: 70000,
    sheetAmount: 70000,
  }],
  ["inkassa-uzs-O-V", {
    ...common,
    action: "INKASSA",
    entityId: `${batch}:INKASSA-UZS-O-V`,
    idempotencyKey: `${batch}:INKASSA-UZS-O-V`,
    receiverName: "GS Test Receiver",
    currency: "UZS",
    amount: 302000,
    inkassaAmount: 302000,
    sheetAmount: 302000,
  }],
  ["inkassa-usd-P-V", {
    ...common,
    action: "INKASSA",
    entityId: `${batch}:INKASSA-USD-P-V`,
    idempotencyKey: `${batch}:INKASSA-USD-P-V`,
    receiverName: "GS Test Receiver",
    currency: "USD",
    amount: 100,
    inkassaAmount: 100,
    sheetAmount: 100,
  }],
  ["inkassa-rub-R-V", {
    ...common,
    action: "INKASSA",
    entityId: `${batch}:INKASSA-RUB-R-V`,
    idempotencyKey: `${batch}:INKASSA-RUB-R-V`,
    receiverName: "GS Test Receiver",
    currency: "RUB",
    amount: 214.29,
    inkassaAmount: 214.29,
    sheetAmount: 214.29,
  }],
  ["doplata-rub-I-V", {
    ...order("DOPLATA-RUB-I-V", "CASH", "RUB", 17.39),
    action: "DOPLATA",
    doplataPeriod: "ДОПЛАТА 3ч",
    period: "ДОПЛАТА 3ч",
    operationName: "Доплата",
  }],
];

const run = async () => {
  const results = [];
  for (const [name, payload] of cases) {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = { raw: body };
    }
    const confirmedByCurrentMapper = parsed?.ok === true
      && (Number.isInteger(parsed?.row) || parsed?.duplicate === true);
    if (!response.ok || parsed?.ok === false || parsed?.error || !confirmedByCurrentMapper) {
      if (response.ok && !confirmedByCurrentMapper) {
        throw new Error(`${name} reached an outdated Apps Script deployment: ${body}`);
      }
      throw new Error(`${name} failed: HTTP ${response.status} ${body}`);
    }
    results.push({ name, status: response.status, row: parsed?.row ?? null, duplicate: Boolean(parsed?.duplicate) });
  }
  console.log(JSON.stringify({ batch, branchCode, results }, null, 2));
};

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
