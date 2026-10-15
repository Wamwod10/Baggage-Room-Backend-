const test = require('node:test');
const assert = require('node:assert/strict');
const { convertMinor, planEdit: rawPlanEdit, recordEdit, convertForPickup, debtBalance } = require('../src/services/orderFinancialEdit.service');
const user = { id: 'manager', login: 'manager' };
const planEdit = (...args) => {
  const previous = process.env.PRICE_APPROVER_USER_IDS;
  process.env.PRICE_APPROVER_USER_IDS = 'manager';
  try { return rawPlanEdit(...args); } finally {
    if (previous === undefined) delete process.env.PRICE_APPROVER_USER_IDS; else process.env.PRICE_APPROVER_USER_IDS = previous;
  }
};
const order = { currency: 'UZS', paymentType: 'CASH', calculatedAmount: 120000, finalAmount: 60000,
  realPaidAmount: 60000, overtimeAmount: 0, cashMovements: [{ id: 'receipt', type: 'ORDER_PAYMENT', direction: 'IN', amount: 60000, currency: 'UZS', paymentType: 'CASH' }] };
test('currency conversion preserves minor units and rounds halves exactly', () => {
  assert.equal(convertMinor(60000, 'UZS', 'USD', 1, 12000), 500);
  assert.equal(convertMinor(500, 'USD', 'UZS', 12000, 1), 60000);
  assert.equal(convertMinor(23, 'UZS', 'USD', 1, 40), 58);
  assert.throws(() => convertMinor(60000, 'UZS', 'USD', 1, 0));
});
test('authorized edit converts price, discount and real receipts together', () => {
  const plan = planEdit(order, { currency: 'USD', exchangeRate: 12000, priceChangeReason: 'Wrong currency' }, user);
  assert.equal(plan.data.finalAmount, 500);
  assert.equal(plan.data.discountAmount, 500);
  assert.equal(plan.data.paymentDifference, 0);
  assert.equal(plan.movements[0].amount, 500);
  assert.equal(order.currency, 'UZS');
});
test('method correction preserves amount, requires permission/reason and never creates debt', () => {
  assert.equal(planEdit(order, { paymentType: 'TERMINAL', priceChangeReason: 'Wrong method' }, user).movements[0].paymentType, 'TERMINAL');
  assert.throws(() => planEdit(order, { paymentType: 'TERMINAL' }, user));
  assert.throws(() => planEdit(order, { paymentType: 'TERMINAL', priceChangeReason: 'test' }, { id: 'employee' }));
  assert.throws(() => planEdit(order, { paymentType: 'DEBT', priceChangeReason: 'test' }, user));
  assert.equal(planEdit(order, { paymentType: 'TERMINAL', realPaidAmount: 1, priceChangeReason: 'test' }, user).data.finalAmount, 1);
});
test('correction appends balancing receipts and durable signed sheet deliveries, preserving original', async () => {
  const source = { ...order, id: 'order', orderNumber: 'TEST-1', branchId: 'branch', branch: { code: 'TSV', name: 'Test' }, items: [], createdAt: new Date() };
  const plan = planEdit(source, { currency: 'USD', exchangeRate: 12000, priceChangeReason: 'Currency' }, user);
  const movements = [], deliveries = [];
  const tx = { shift: { findFirst: async () => ({ id: 'shift' }) }, cashMovement: { create: async ({data}) => movements.push(data) },
    financialOutbox: { create: async ({data}) => deliveries.push(data) } };
  await recordEdit(tx, source, { ...source, ...plan.data }, plan, user, 'edit-key', 'Currency');
  assert.deepEqual(movements.map((m) => [m.direction, m.amount, m.currency]), [['OUT',60000,'UZS'],['IN',500,'USD']]);
  assert.equal(source.cashMovements[0].amount, 60000);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].payload.amount, -60000);
  assert.equal(deliveries[1].payload.amount, 5); // Sheets payloads use major currency units.
  assert.notEqual(deliveries[0].deliveryKey, deliveries[1].deliveryKey);
  await assert.rejects(() => recordEdit({ ...tx, shift: { findFirst: async () => null } }, source, source, plan, user, 'key', 'Currency'), /shift/);
});
test('repeat correction skips replaced receipts and conserves total across rounding', () => {
  const first = { id:'old', type:'ORDER_PAYMENT', direction:'IN', amount:100, currency:'USD', paymentType:'CASH' };
  const corrected = { ...order, currency:'USD', pricingSnapshot:{ exchangeRate:12000 }, calculatedAmount:100, finalAmount:100, realPaidAmount:100,
    cashMovements: [first, { ...first, direction:'OUT', financialKind:'EDIT_CORRECTION', note:'Edit correction source:old' }, { ...first,id:'new' }] };
  const plan = planEdit(corrected, { currency:'UZS', priceChangeReason:'test' }, user);
  assert.equal(plan.movements.length,1); assert.equal(plan.movements[0].source.id,'new');
  assert.equal(plan.data.realPaidAmount,12000);
});
test('order edit converts and records atomically through the existing save flow; replay adds no receipts', async () => {
  const prisma = require('../src/config/prisma');
  const telegram = require('../src/services/telegram.service');
  const sheets = require('../src/services/googleSheets.service');
  const original = { transaction: prisma.$transaction, lookup: prisma.order.findUnique, telegram: telegram.sendSafely, sheets: sheets.sendSafely, approvers:process.env.PRICE_APPROVER_USER_IDS };
  const state = { ...structuredClone(order), id:'order1', orderNumber:'TEST-1', branchId:'branch', branch:{code:'TSV',name:'Test'}, status:'ACTIVE',
    discountAmount:60000, paymentDifference:0, updatedAt:new Date(), items:[{ id:'item', unitPrice:120000, originalPrice:120000, discountAmount:60000, finalPrice:60000, currency:'UZS' }] };
  const outbox = [], audits = [];
  const lookup = async ({where}) => where.editIdempotencyKey && state.editIdempotencyKey !== where.editIdempotencyKey ? null : structuredClone(state);
  const tx = { $queryRaw:async()=>[], order:{findUnique:lookup, updateMany:async({data})=>{ Object.assign(state,data,{updatedAt:new Date()});return{count:1}; }},
    orderItem:{update:async({data})=>Object.assign(state.items[0],data)}, financialRequest:{findMany:async()=>[]}, shift:{findFirst:async()=>({id:'shift'})},
    cashMovement:{create:async({data})=>{state.cashMovements.push({id:`receipt-${state.cashMovements.length}`, ...data});}},
    financialOutbox:{create:async({data})=>outbox.push(data)}, auditLog:{create:async({data})=>audits.push(data)} };
  try {
    process.env.PRICE_APPROVER_USER_IDS='manager';
    prisma.$transaction = async (fn)=>fn(tx); prisma.order.findUnique=lookup; telegram.sendSafely=()=>{}; sheets.sendSafely=()=>{};
    const service = require('../src/services/order.service');
    const body={ currency:'USD', paymentType:'TERMINAL', exchangeRate:12000, finalAmount:500, realPaidAmount:500, priceChangeReason:'Correct currency and method' };
    const result=await service.updateOrder({...user,role:'SUPER_ADMIN'},state.id,body,{idempotencyKey:'financial-edit-integration'});
    assert.equal(result.currency,'USD'); assert.equal(result.paymentType,'TERMINAL');
    assert.equal(result.items[0].originalPrice,1000); assert.equal(result.pricingSnapshot.exchangeRate,12000);
    assert.equal(state.cashMovements.length,3); assert.equal(outbox.length,2); assert.equal(audits.length,1);
    await service.updateOrder({...user,role:'SUPER_ADMIN'},state.id,body,{idempotencyKey:'financial-edit-integration'});
    assert.equal(state.cashMovements.length,3); assert.equal(outbox.length,2);
    const corrected=await service.updateOrder({...user,role:'SUPER_ADMIN'},state.id,{realPaidAmount:250,finalAmount:500,priceChangeReason:'Correct receipt amount'},{idempotencyKey:'paid-amount-edit'});
    assert.equal(corrected.realPaidAmount,250);assert.equal(corrected.finalAmount,250);assert.equal(corrected.discountAmount,750);
    assert.equal(state.cashMovements.length,5);assert.equal(outbox.length,4);
    assert.throws(()=>planEdit({...order,cashMovements:[]},{paymentType:'TERMINAL',priceChangeReason:'test'},user),/reconciliation/);
  } finally {
    if (original.approvers === undefined) delete process.env.PRICE_APPROVER_USER_IDS; else process.env.PRICE_APPROVER_USER_IDS=original.approvers;
    prisma.$transaction=original.transaction; prisma.order.findUnique=original.lookup;
    telegram.sendSafely=original.telegram; sheets.sendSafely=original.sheets;
  }
});
test('legacy rate snapshot keeps legacy overtime pricing after conversion', () => {
  const service = require('../src/services/order.service');
  assert.equal(service._internals.calculateOvertimeAmount({ order:{currency:'USD',pricingSnapshot:{version:0,exchangeRate:12000},items:[{size:'S',count:1,unitPrice:100,tariffHours:1}],checkIn:new Date(0)}, tariffs:[{size:'S',price1h:12000}],overtimeHours:1,actualTime:new Date(100*3600000) }),100);
});
test('manual paid amount changes rebuild receipts and reconcile discount without changing permissions', () => {
  assert.equal(debtBalance({ finalAmount:100,realPaidAmount:50,debt:{status:'OPEN',amount:50} },
    { data:{finalAmount:1,realPaidAmount:0},convert:(amount)=>convertMinor(amount,'UZS','USD',1,12500) }),1);
  const lower = planEdit(order,{realPaidAmount:30000,priceChangeReason:'Correct amount'},user);
  assert.equal(lower.data.realPaidAmount,30000);assert.equal(lower.data.finalAmount,30000);
  assert.equal(lower.data.discountAmount,90000);assert.equal(lower.movements[0].amount,30000);
  const higher = planEdit(order,{realPaidAmount:80000,priceChangeReason:'Correct amount'},user);
  assert.equal(higher.data.realPaidAmount,80000);assert.equal(higher.movements[0].amount,80000);
  assert.throws(()=>planEdit(order,{realPaidAmount:30000},user),/sabab/);
  const debt={...order,paymentType:'DEBT',realPaidAmount:0,cashMovements:[]};
  assert.throws(()=>planEdit(debt,{realPaidAmount:10000,priceChangeReason:'test'},user),/turini/);
  assert.throws(()=>planEdit(debt,{realPaidAmount:10000,paidPaymentType:'DEBT',priceChangeReason:'test'},user),/turini/);
  assert.equal(planEdit(debt,{realPaidAmount:10000,paidPaymentType:'TERMINAL',priceChangeReason:'test'},user).movements[0].paymentType,'TERMINAL');
});
test('pickup currency correction converts persisted order, items and receipts in the pickup transaction', async () => {
  const source={...structuredClone(order),id:'order',branchId:'branch',branch:{code:'TSV',name:'Test'},orderNumber:'TEST',items:[{id:'item',unitPrice:120000,originalPrice:120000,discountAmount:60000,finalPrice:60000}],debt:null};
  const movements=[...source.cashMovements],writes=[],deliveries=[],audits=[];
  const tx={ financialRequest:{findMany:async()=>[]},shift:{findFirst:async()=>({id:'shift'})},
    orderItem:{update:async({data})=>writes.push(data)},order:{update:async({data})=>writes.push(data)},
    cashMovement:{create:async({data})=>movements.push({...data,id:`new${movements.length}`}),findMany:async()=>movements},
    financialOutbox:{create:async({data})=>deliveries.push(data)},auditLog:{create:async({data})=>audits.push(data)} };
  const body={currency:'USD',exchangeRate:12000,priceChangeReason:'Currency at pickup'};
  const result=await convertForPickup(tx,source,body,{id:'owner',role:'SUPER_ADMIN'},'pickup-key');
  assert.equal(result.currency,'USD');assert.equal(result.realPaidAmount,500);assert.equal(result.items[0].unitPrice,1000);
  assert.equal(movements.length,3);assert.equal(deliveries.length,2);assert.equal(audits.length,1);
  assert.equal(source.currency,'UZS');assert.equal(writes.length,2);
  tx.financialRequest.findMany=async()=>[{id:'pending'}];
  await assert.rejects(()=>convertForPickup(tx,source,body,{id:'owner',role:'SUPER_ADMIN'},'key'),/so‘rov/);
  assert.equal(writes.length,2);
});
