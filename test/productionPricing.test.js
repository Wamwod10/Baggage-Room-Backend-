const test = require('node:test');
const assert = require('node:assert/strict');
const { calculatePrice } = require('../src/services/tariff.service');
const { serializeRecord, serializeSales, serializeCash } = require('../src/integrations/jarvis/serializers');
const { normalizeCurrencyAmount } = require('../src/utils/money');
const { formatMoney } = require('../src/utils/formatTelegramMessage');
const rates = { S: { price1h: 4000, price12h: 40000, price24h: 75000, price48h: 120000, price72h: 180000, after72hPrice: 30000 }, M: { price1h: 6000, price12h: 55000 }, L: { price1h: 8000, price12h: 75000 } };
const price = (size, hours, options = {}) => calculatePrice(rates[size], hours, { branchCode: 'TJV', isCustom: true, dailyRate: 30000, ...options });
test('TJV manual boundaries retain short hours and 72+ daily rule', () => {
  for (const [hours, expected] of [[1,4000],[12,48000],[13,44000],[14,48000],[15,52000],[24,88000],[48,184000],[72,280000],[73,120000],[12.01,44000],[14.1,52000]]) assert.equal(price('S', hours), expected, String(hours));
});
test('TJV examples charge every size and count without discounts', () => {
  assert.equal(2 * price('S',14), 96000);
  assert.equal(2 * price('S',15) + price('M',15), 177000);
  assert.equal(price('S',14), 48000);
  assert.equal(price('M',15) + 3 * price('L',15), 370000);
  assert.equal(price('M',18) + 3 * price('L',18), 460000);
});
test('other branches and TJV presets are unchanged', () => {
  for (const branchCode of ['TIA','SIA','TSV','SVK',undefined]) for (const hours of [1,12,13,14,15,24,48,72]) assert.equal(price('S',hours,{branchCode}),hours*4000);
  for (const [hours,expected] of [[1,4000],[12,40000],[24,75000],[48,120000],[72,180000]]) assert.equal(price('S',hours,{isCustom:false}),expected);
});
for (const [amount,currency,expected] of [[214285,'RUB','2142.85'],[13280,'USD','132.80'],[85715,'RUB','857.15'],[7360,'USD','73.60'],[96000,'UZS','96000']]) test('minor-unit display '+amount+' '+currency, () => {
  const result=serializeRecord('orders',{currency,calculatedAmount:amount,finalAmount:amount,discountAmount:0,realPaidAmount:amount,overtimeAmount:0});
  assert.equal(result.calculatedAmount,amount);
  assert.equal(result.discountAmount,0);
  assert.equal(normalizeCurrencyAmount(amount,currency),Number(expected));
  assert.equal(formatMoney(amount,currency).replace(/ /g,'').replace(',','.').replace(/[^0-9.]/g,''),expected);
});
test('Jarvis preserves exact minor integers without rescaling',()=>{
 const result=serializeSales({currency:'USD',grossReceipts:'9007199254740995',refunds:'10',netReceipts:'9007199254740985',transactionCount:2});
 assert.equal(result.grossReceipts,'9007199254740995');
 assert.equal(result.refunds,'10');
 const cash=serializeCash({currency:'RUB',opening:'214285',accepted:'0',movementNet:'-10'},null);
 assert.equal(cash.balance,'214275');
 const refund=serializeRecord('transactions',{currency:'USD',amount:7360,direction:'OUT'});
 assert.equal(refund.signedAmount,-7360);
});

test('pricing quote passes TJV scope, count and minor-unit conversion', async (t) => {
 const prismaPath=require.resolve('../src/config/prisma');
 const pricingPath=require.resolve('../src/services/pricing.service');
 const cbuPath=require.resolve('../src/services/cbuRates.service');
 const previousCbu=require.cache[cbuPath];
 const previousPrisma=require.cache[prismaPath], previousPricing=require.cache[pricingPath];
 require.cache[cbuPath]={id:cbuPath,filename:cbuPath,loaded:true,exports:{
   getRate:async(currency)=>({ currency, rate:currency==='USD'?12500:currency==='RUB'?146.75:1, publishedRate:currency==='USD'?'12500':currency==='RUB'?'146.75':'1', nominal:1, effectiveDate:'2026-10-28', source:currency==='UZS'?'UZS':'CBU' })
 }};
 require.cache[prismaPath]={id:prismaPath,filename:prismaPath,loaded:true,exports:{
   branch:{findUnique:async()=>({id:'tjv',code:'TJV'})},
   tariff:{findMany:async()=>Object.entries(rates).map(([size,rate])=>({size,...rate}))}
 }};
 delete require.cache[pricingPath];
 t.after(()=>{require.cache[prismaPath]=previousPrisma;if(previousPricing)require.cache[pricingPath]=previousPricing;else delete require.cache[pricingPath];if(previousCbu)require.cache[cbuPath]=previousCbu;else delete require.cache[cbuPath];});
 const {quote}=require('../src/services/pricing.service');
 const body={branchId:'tjv',hours:15,isCustom:true,currency:'UZS',items:[{size:'S',count:2},{size:'M',count:1}]};
 assert.equal((await quote({role:'SUPER_ADMIN'},body)).calculatedAmount,177000);
 assert.equal((await quote({role:'SUPER_ADMIN'},{...body,currency:'USD',exchangeRate:12500})).calculatedAmount,1416);
 const rub = await quote({role:'SUPER_ADMIN'}, {...body, currency:'RUB', exchangeRate:89});
 assert.equal(rub.exchangeRate, 146.75, 'client-supplied stale rate must be ignored');
 const { convertUzsToCurrencyMinor } = require('../src/utils/money');
 assert.equal(rub.calculatedAmount, convertUzsToCurrencyMinor(52000,'RUB',146.75)*2 + convertUzsToCurrencyMinor(73000,'RUB',146.75));
});

test('new TJV foreign-currency overtime uses corrected base, historical snapshots retain hourly rule',()=>{
 const {calculateOvertimeAmount}=require('../src/services/order.service')._internals;
 const order={currency:'USD',customHours:15,discountAmount:0,checkIn:new Date(),items:[{size:'S',count:1,tariffHours:15,unitPrice:416}],pricingSnapshot:{version:1,customTariffRule:'TJV_12H_PLUS_HOURLY'}};
 assert.equal(calculateOvertimeAmount({order,tariffs:[{size:'S',...rates.S}],overtimeHours:1}),32);
 const historical={...order,items:[{...order.items[0],unitPrice:480}],pricingSnapshot:{version:1}};
 assert.equal(calculateOvertimeAmount({order:historical,tariffs:[{size:'S',...rates.S}],overtimeHours:1}),32);
});
