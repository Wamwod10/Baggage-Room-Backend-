require("dotenv").config();

const sheets = require("../src/services/googleSheets.service");

const run = async () => {
  const entityId = `GS-INKASSA-SVK-${Date.now()}`;
  const payload = sheets._internals.inkassaPayload({
    id: entityId,
    branch: { code: "SVK", name: "Samarqand vokzal" },
    receiverName: "Admin",
    note: "SVK real mapping test",
    amount: "500 000",
    currency: "UZS",
    createdAt: new Date(),
  });

  if (payload.amount !== 500000 || payload.sheetAmount !== 500000) {
    throw new Error(`INKASSA parser mismatch before send: amount=${payload.amount}, sheetAmount=${payload.sheetAmount}`);
  }

  const result = await sheets._internals.postWebhook(payload);
  const row = result.finalRow;
  if (!Array.isArray(row) || row.length !== 22) throw new Error("Real response finalRow must contain 22 columns");
  if (row[1] !== "Admin") throw new Error(`Real INKASSA B mismatch: ${row[1]}`);
  if (row[14] !== 500000) throw new Error(`Real INKASSA O mismatch: ${row[14]}`);
  if (row.slice(5, 14).some((value) => value !== "")) throw new Error("Real INKASSA wrote to F:N");
  if (row[20] !== "") throw new Error(`Real INKASSA U must be empty, got ${row[20]}`);
  if (row[21] !== "Inkassa - Admin") throw new Error(`Real INKASSA V mismatch: ${row[21]}`);

  console.log(JSON.stringify({
    success: true,
    action: payload.action,
    branchCode: payload.branchCode,
    amount: payload.amount,
    currency: payload.currency,
    scriptVersion: result.scriptVersion,
    sheetRow: result.responseJson?.row,
    row14: row[14],
    finalRow: row,
  }, null, 2));
};

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
