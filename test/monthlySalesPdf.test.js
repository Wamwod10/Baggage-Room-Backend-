const test = require('node:test');
const assert = require('node:assert/strict');
const { monthRangeTashkent, buildSalesHistoryPdf, downloadMonthlySalesPdf } = require('../src/services/monthlySalesPdf.service');
const ordersService = require('../src/services/order.service');

const makeOrder = (i, currency = 'UZS') => ({
  id: `order-${i}`, orderNumber: `TJV-${String(i).padStart(6, '0')}`,
  clientName: `Тест Мижоз (${i})`, phone: '+998901234567',
  currency, realPaidAmount: currency === 'USD' ? 1600 : 180000,
  calculatedAmountUZS: 180000, createdAt: '2026-11-05T08:30:00.000Z',
  branch: { name: 'Toshkent Janubiy vokzal' }, status: 'PICKED_UP',
  paymentType: 'CASH', items: [{ size: 'L', count: 1, lockerNumber: 1 }],
});

test('monthly PDF date range uses Tashkent boundaries including leap years and December', () => {
  assert.deepEqual(monthRangeTashkent('2026-11'), {
    dateFrom: '2026-10-31T19:00:00.000Z', dateTo: '2026-11-30T18:59:59.999Z',
  });
  assert.equal(monthRangeTashkent('2024-02').dateTo, '2024-02-29T18:59:59.999Z');
  assert.equal(monthRangeTashkent('2026-12').dateTo, '2026-12-31T18:59:59.999Z');
  assert.throws(() => monthRangeTashkent('2026-13'), {statusCode: 400});
  assert.throws(() => monthRangeTashkent('2026-11-01'), {statusCode: 400});
});

test('PDF contains all orders across pages with distinct currency totals and valid cross reference', () => {
  const data = Array.from({ length: 47 }, (_, i) => makeOrder(i + 1, i === 1 ? 'USD' : 'UZS'));
  const pdf = buildSalesHistoryPdf(data, {month:'2026-11', now:new Date('2026-11-09T12:30:00.000Z')});
  const content = pdf.toString('latin1');
  assert.ok(content.startsWith('%PDF-1.4'));
  assert.ok(content.includes('Jami buyurtmalar: 47'));
  assert.ok(content.includes('USD: 16.00'));
  assert.ok(content.includes('UZS: 8 280 000'));
  assert.ok(content.includes('TJV-000001'));
  assert.ok(content.includes('TJV-000047'));
  assert.match(content, /\/Count 3 >>/);
  assert.equal((content.match(/\/Type \/Page \/Parent/g) || []).length, 3);
  assert.ok(content.includes('Test Mijoz')); // Uzbek Cyrillic transliterated safely
  const offset = Number(content.match(/startxref\n(\d+)\n%%EOF/)[1]);
  assert.equal(content.slice(offset, offset + 4), 'xref');
});

test('empty month remains a valid one-page PDF', () => {
  const pdf = buildSalesHistoryPdf([], {month:'2026-11'});
  const s = pdf.toString('latin1');
  assert.ok(s.includes('Jami buyurtmalar: 0'));
  assert.match(s, /\/Count 1 >>/);
});

test('unauthorized staff cannot export, with no database read', async () => {
  const original = ordersService.listOrders;
  let calls = 0;
  try {
    ordersService.listOrders = async () => { calls++; return {items:[],pagination:{total:0}}; };
    await assert.rejects(() => downloadMonthlySalesPdf({id:'staff',role:'BRANCH_ADMIN'}, {month:'2026-11'}), {statusCode:403});
    assert.equal(calls, 0);
  } finally { ordersService.listOrders = original; }
});

test('monthly report paginates all rows and respects requested branch and date boundaries', async () => {
  const original = ordersService.listOrders;
  const pages = [];
  const source = Array.from({length:401}, (_,i)=>makeOrder(i+1));
  try {
    ordersService.listOrders = async (_user, query) => {
      pages.push(query);
      const start = (query.page-1)*query.limit;
      return {items:source.slice(start,start+query.limit),pagination:{total:401}};
    };
    const pdf = await downloadMonthlySalesPdf({id:'owner',role:'SUPER_ADMIN'}, {month:'2026-11',branchId:'branch-a'});
    assert.deepEqual(pages.map(x=>x.page), [1,2,3]);
    assert.ok(pages.every(x=>x.branchId==='branch-a'));
    assert.ok(pages.every(x=>x.dateFrom==='2026-10-31T19:00:00.000Z'));
    assert.ok(pdf.toString('latin1').includes('TJV-000401'));
  } finally { ordersService.listOrders = original; }
});
