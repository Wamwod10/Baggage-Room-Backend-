const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeShiftOrders, loadShiftClosingAnalytics } = require("../src/services/shiftClosingAnalytics.service");
const { shiftClosedMessage, shiftSalesSnapshotMessage } = require("../src/utils/formatTelegramMessage");

const payment = (amount, currency = "UZS", rate = null, note = "Order test", direction = "IN") => ({
  amount, currency, direction, type: "ORDER_PAYMENT", paymentType: "CASH", note,
  order: currency === "UZS" ? null : { currency, exchangeRate: rate },
});
const order = (number, uzs, options = {}) => ({
  orderNumber: number, currency: "UZS", calculatedAmount: uzs, calculatedAmountUZS: uzs,
  status: "ACTIVE", items: [{ size: "S", count: 1 }], ...options,
});

test("shift analytics exclude cancelled test orders from price ranking and baggage counts", () => {
  const summary = summarizeShiftOrders({
    orders: [
      order("TIA-000001", 100000, { items: [{size:"S",count:2},{size:"M",count:1}] }),
      order("TIA-000002", 250000, { items: [{size:"L",count:2}] }),
      order("TIA-000003", 35000, { items: [{size:"XL",count:1}] }),
      order("TIA-TEST", 9999999, { status:"CANCELLED",items:[{size:"XL",count:20}] }),
    ],
    pickups: 2, cancellations: 1, delayed: 3,
    movements: [payment(500000),payment(680000,"UZS",null,"Order card")],
    previousMovements: [payment(1000000)],
  });
  assert.equal(summary.received,4);
  assert.equal(summary.pickups,2);
  assert.equal(summary.cancellations,1);
  assert.equal(summary.delayed,3);
  assert.equal(summary.highest.number,"TIA-000002");
  assert.equal(summary.lowest.number,"TIA-000003");
  assert.equal(summary.averageTariffUzs,128333);
  assert.deepEqual(summary.sizes,{S:2,M:1,L:2,XL:1});
  assert.equal(summary.comparisonPercent,18);
});

test("merged shift Telegram message includes closure, analytics, payment types and original cash reconciliation", () => {
  const shiftAnalytics = summarizeShiftOrders({
    orders:[order("TIA-000001",250000),order("TIA-000002",35000)],
    pickups:1,cancellations:0,delayed:0,
    movements:[
      payment(500000),
      {...payment(680000),paymentType:"TERMINAL"},
      payment(5000,"USD",11500),
      payment(10000,"RUB",130),
      payment(120000,"UZS",null,"Additional payment TIA-000001"),
    ],
    previousMovements:[payment(1000000)],
  });
  const shift = {
    id:"shift-one",branchId:"branch-one",branch:{name:"Toshkent xalqaro aeroport"},
    acceptedByName:"Dinara",openedBy:{name:"Dinara"},closedBy:{name:"Dinara"},
    openedAt:new Date("2026-11-27T04:00:00Z"),closedAt:new Date("2026-11-27T16:00:00Z"),
    openingCashByCurrency:{UZS:0},acceptedCashByCurrency:{UZS:50000},
    expenseByCurrency:{UZS:100000},salaryByCurrency:{UZS:50000},
    inkassaByCurrency:{UZS:200000},debtByCurrency:{},
    cashBalanceByCurrency:{UZS:1200000},shiftAnalytics,
  };
  const message = shiftClosedMessage(shift);
  assert.equal((message.match(/Smena yopildi/g)||[]).length,1); // only one close headline, no duplicated status
  assert.doesNotMatch(message,/📊 Smena yakuniy hisoboti/);
  assert.ok(message.split('\n').length < 20, 'compact Telegram report should fit a phone screen');
  assert.match(message,/👤 Dinara/);
  assert.match(message,/Buyurtmalar: 2 qabul \| 1 topshirildi/);
  assert.match(message,/Eng qimmat: TIA-000001 — 250 000 so'm/);
  assert.match(message,/Eng arzon: TIA-000002 — 35 000 so'm/);
  assert.match(message,/Qo'shimcha: 120 000 so'm \(1 ta\)/);
  assert.match(message,/50\$ → 575 000 so'm/);
  assert.match(message,/100₽ → 13 000 so'm/);
  assert.match(message,/Terminal: 680 000 so'm/);
  assert.match(message,/shundan oylik: 50 000 so'm/);
  assert.match(message,/Inkassa: 200 000 so'm/);
  assert.match(message,/Kassada qolgan: 1 200 000 so'm/);
  assert.doesNotMatch(message,/📊 Savdo hisoboti/);
  assert.equal((message.match(/Jami tushum:/g)||[]).length,1);
  assert.match(message,/Jami tushum: 1 888 000 so'm/);
  assert.equal(shiftSalesSnapshotMessage({ telegramSalesSummary: shiftAnalytics.revenue }).includes("📊 Savdo hisoboti"),true);
});

test("missing old FX rate suppresses percentage comparison instead of fabricating results", () => {
  const x = summarizeShiftOrders({
    orders:[order("TIA-000099",50000,{currency:"USD",calculatedAmountUZS:null,calculatedAmount:400})],
    movements:[payment(10000,"USD",null)],previousMovements:[payment(100000)],
  });
  assert.equal(x.missingTariffs,1);
  assert.equal(x.highest,null);
  assert.equal(x.comparisonPercent,null);
  const message=shiftClosedMessage({shiftAnalytics:x});
  assert.match(message,/1 ta buyurtmaning tarifi noma'lum/);
  assert.match(message,/Kursi yo'q valyutalar jamiga kiritilmadi/);
});

test("loader confines order counts and pickups to the closed shift and reads previous branch shift", async () => {
  const observed = [];
  const shift = { id:"shift-current",branchId:"branch-one",openedAt:new Date("2026-11-27T04:00:00Z"),closedAt:new Date("2026-11-27T16:00:00Z") };
  const db={
    order:{
      findMany:async(args)=>{observed.push(["orders",args]);return [order("TIA-000001",250000)]},
      count:async(args)=>{observed.push(["count",args]);return 1},
    },
    cashMovement:{findMany:async(args)=>{observed.push(["cash",args]);return [payment(100000)]}},
    shift:{findFirst:async(args)=>{observed.push(["previous",args]);return {id:"shift-previous"}}},
  };
  const result=await loadShiftClosingAnalytics(db,shift);
  assert.equal(result.received,1);
  assert.equal(result.comparisonPercent,0);
  assert.deepEqual(observed.filter(([type])=>type==="cash").map(([,args])=>args.where.shiftId),["shift-current","shift-previous"]);
  assert.deepEqual(observed.find(([type])=>type==="orders")[1].where.createdAt,{gte:shift.openedAt,lte:shift.closedAt});
  assert.ok(observed.filter(([type])=>type==="count").some(([,args])=>args.where.cancelledAt?.gte.getTime()===shift.openedAt.getTime()));
});
