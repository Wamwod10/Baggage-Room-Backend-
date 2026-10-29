// GOOGLE FINANCE ONLY. No cbu.uz or GOOGLE market scrapers.
// Copy into Google Apps Script Code.gs. This script creates its own Google Sheet.
// Staging first: do not use for commercial payment pricing before licensing review.
var GF_CODES = ['USD','EUR','RUB','KZT','TJS'];
var GF_SHEET_NAME = 'Google Finance Quotes';
function gfBusinessDate_() {
  return Utilities.formatDate(new Date(),'Asia/Tashkent','yyyy-MM-dd');
}
function setupGoogleFinanceSheet() {
  var props=PropertiesService.getScriptProperties();
  var id=props.getProperty('GF_SHEET_ID');
  var book;
  if (id) book=SpreadsheetApp.openById(id);
  else {
    book=SpreadsheetApp.create('Qonoq Baggage - Google Finance FX (staging)');
    props.setProperty('GF_SHEET_ID',book.getId());
  }
  var sheet=book.getSheetByName(GF_SHEET_NAME)||book.insertSheet(GF_SHEET_NAME);
  sheet.getRange('A1:C1').setValues([['Valyuta','Google Finance / 1 birlik = UZS','Formula']]);
  GF_CODES.forEach(function(currency,index){
    var row=index+2, symbol='CURRENCY:'+currency+'UZS';
    sheet.getRange(row,1).setValue(currency);
    sheet.getRange(row,2).setFormula('=GOOGLEFINANCE("'+symbol+'")');
    sheet.getRange(row,3).setValue(symbol);
  });
  sheet.setFrozenRows(1);
  sheet.getRange('B2:B6').setNumberFormat('0.0000000000');
  SpreadsheetApp.flush();
  var result={ready:true,sheetUrl:book.getUrl(),sheetId:book.getId()};
  console.log(JSON.stringify(result));
  return result;
}
function gfReadRates_() {
  var id=PropertiesService.getScriptProperties().getProperty('GF_SHEET_ID');
  if(!id) throw Error('First run setupGoogleFinanceSheet()');
  var sheet=SpreadsheetApp.openById(id).getSheetByName(GF_SHEET_NAME);
  if(!sheet) throw Error('Google Finance sheet missing. Run setupGoogleFinanceSheet()');
  SpreadsheetApp.flush();
  var values=sheet.getRange('A2:B6').getValues();
  var rates=[];
  GF_CODES.forEach(function(code,index){
    var row=values[index];
    if(row[0]!==code) throw Error('Google Finance currency order changed: '+code);
    if(typeof row[1]!=='number'||!Number.isFinite(row[1])||
       row[1]<=0||row[1]>1e9) {
      throw Error('GOOGLEFINANCE has no numeric '+code+'/UZS quote. Do not submit a guessed rate.');
    }
    var text=row[1].toFixed(10).replace(/0+$/,'').replace(/\.$/,'');
    if(!/^\d+(?:\.\d{1,10})?$/.test(text)) throw Error('Invalid Google Finance rate precision');
    rates.push({currency:code,rate:text});
  });
  return rates;
}
function probeGoogleFinance() {
  var rates=gfReadRates_();
  var result={source:'GOOGLE_FINANCE',observedAt:new Date().toISOString(),
    currencies:rates.length, rates:rates};
  console.log(JSON.stringify(result));
  return result;
}
function gfConfig_(){
  var p=PropertiesService.getScriptProperties();
  var secret=p.getProperty('GOOGLE_FINANCE_SYNC_SECRET');
  var target=p.getProperty('GOOGLE_FINANCE_SYNC_URL');
  if(!secret||Utilities.newBlob(secret).getBytes().length<32||
    !/^https:\/\/[^/?#]+\/api\/integrations\/google-finance-sync$/.test(target||'')){
    throw Error('Google Finance staging Script Properties are missing or invalid');
  }
  return {secret:secret,target:target};
}
function syncGoogleFinanceRates(){
  var lock=LockService.getScriptLock();
  if(!lock.tryLock(5000)) throw Error('Google Finance synchronization already running');
  try {
    var config=gfConfig_();
    var rates=gfReadRates_();
    var observedAt=new Date().toISOString();
    var body=JSON.stringify({source:'GOOGLE_FINANCE',observedAt:observedAt,rates:rates});
    var ts=String(Date.now());
    var signed=Utilities.computeHmacSha256Signature(ts+'.'+body,config.secret,Utilities.Charset.UTF_8);
    var signature=signed.map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');
    var response=UrlFetchApp.fetch(config.target,{method:'post',
      contentType:'application/json',payload:body,muteHttpExceptions:true,
      followRedirects:false,headers:{
        'X-Google-FX-Timestamp':ts,'X-Google-FX-Signature':'sha256='+signature
      }});
    if(response.getResponseCode()!==200) throw Error('Google Finance staging backend HTTP '+response.getResponseCode());
    var ack=JSON.parse(response.getContentText());
    if(ack.accepted!==true||ack.source!=='GOOGLE_FINANCE'||
       ack.day!==gfBusinessDate_()||ack.currencies!==5) throw Error('Unexpected backend FX acknowledgement');
    console.log(JSON.stringify({status:'GOOGLE_FINANCE_SYNC_OK',date:ack.day,currencies:5}));
    return ack;
  } finally {lock.releaseLock();}
}
function installGoogleFinanceTrigger(){
  var installed=ScriptApp.getProjectTriggers().some(function(x){
    return x.getHandlerFunction()==='syncGoogleFinanceRates';
  });
  if(!installed) ScriptApp.newTrigger('syncGoogleFinanceRates').timeBased().everyMinutes(30).create();
  return {installed:!installed};
}
function stopGoogleFinanceTrigger(){
  ScriptApp.getProjectTriggers().forEach(function(x){
    if(x.getHandlerFunction()==='syncGoogleFinanceRates') ScriptApp.deleteTrigger(x);
  });
}
function activateGoogleFinanceOnStaging(){
  probeGoogleFinance();
  syncGoogleFinanceRates();
  return installGoogleFinanceTrigger();
}
