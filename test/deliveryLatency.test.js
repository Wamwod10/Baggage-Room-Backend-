const test = require('node:test');
const assert = require('node:assert/strict');
const sheets = require('../src/services/googleSheets.service');

const expectedSheetId = sheets._internals.EXPECTED_SPREADSHEET_ID_BY_BRANCH_CODE.SVK;
const makeResponse = (overrides = {}) => ({
  scriptVersion: sheets._internals.EXPECTED_SCRIPT_VERSION,
  branchCode: 'SVK', spreadsheetId: expectedSheetId, spreadsheetName: 'Самарканд вокзал',
  monthSheetName: 'Ноябрь  2026', sheetName: 'Ноябрь  2026',
  row: 30, finalRow: Array(22).fill(''),
  ...overrides,
});
const payload = { branchCode: 'SVK', monthSheetName: 'Ноябрь 2026', action: 'NEW_ORDER' };

test('Sheets recognizes written November rows despite repeated whitespace', () => {
  const value=sheets._internals.validateWebhookResult(payload,makeResponse());
  assert.equal(value.row.length,22);
  sheets._internals.validateWebhookResult(payload,makeResponse({
    monthSheetName:' Ноябрь\u00a0 2026 ',sheetName:' Ноябрь\u00a0 2026 '
  }));
});

test('Sheets still rejects a different month, branch or spreadsheet',()=>{
  for (const overrides of [
    {sheetName:'Декабрь 2026'},
    {monthSheetName:'Октябрь 2026'},
    {branchCode:'TIA'},
    {spreadsheetId:'wrong'},
  ]) {
    assert.throws(()=>sheets._internals.validateWebhookResult(payload,makeResponse(overrides)));
  }
});
