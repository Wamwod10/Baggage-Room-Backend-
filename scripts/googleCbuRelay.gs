// Google Apps Script V8; paste into script.google.com. Test with staging ONLY.
// Script Properties: CBU_SYNC_SHARED_SECRET (32+ bytes), CBU_SYNC_TARGET_URL (HTTPS staging backend).
var FX_CODES = ['USD','EUR','RUB','KZT','TJS'];
function fxDay() { return Utilities.formatDate(new Date(),'Asia/Tashkent','yyyy-MM-dd'); }
function fxValidate(rows, day) {
  if (!Array.isArray(rows) || rows.length < 5) throw Error('Invalid CBU payload');
  return FX_CODES.map(function(code) {
    var found = rows.filter(function(r){ return r && r.Ccy === code; });
    if (found.length !== 1) throw Error('CBU currency missing or duplicated: '+code);
    var r = found[0], rate = String(r.Rate||'').trim().replace(',','.');
    var nominal = Number(r.Nominal);
    if (!/^\d+(?:\.\d{1,12})?$/.test(rate) || Number(rate)<=0 ||
        !Number.isSafeInteger(nominal) || nominal<=0) throw Error('Invalid CBU rate: '+code);
    var match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(r.Date||''));
    if (!match) throw Error('Invalid CBU date');
    var iso = match[3]+'-'+match[2]+'-'+match[1];
    var start = Date.parse(iso+'T00:00:00Z'), end = Date.parse(day+'T00:00:00Z');
    if (!Number.isFinite(start) || start > end) throw Error('Future CBU publication');
    var weekdays = 0;
    for (var t=start+86400000;t<=end;t+=86400000) {
      var weekday = new Date(t).getUTCDay();
      if (weekday!==0 && weekday!==6) weekdays++;
      if (weekdays>1) throw Error('Stale official CBU publication');
    }
    return {Ccy:code,Rate:rate,Nominal:nominal,Date:r.Date};
  });
}
function fxFetch() {
  var day=fxDay();
  var base='https://cbu.uz/uz/arkhiv-kursov-valyut/json/';
  var urls=[base+'all/'+day+'/',base],errors=[];
  for (var i=0;i<urls.length;i++) {
    try {
      var res=UrlFetchApp.fetch(urls[i],{muteHttpExceptions:true,headers:{Accept:'application/json'}});
      if(res.getResponseCode()!==200) throw Error('CBU HTTP '+res.getResponseCode());
      return {day:day,rates:fxValidate(JSON.parse(res.getContentText('UTF-8')),day)};
    } catch(err) {errors.push(err.message);}
  }
  throw Error('No fresh official CBU feed: '+errors.join('; '));
}
function probeCbu() {
  var quote=fxFetch();
  var result={reachable:true,day:quote.day,effectiveDate:quote.rates[0].Date,currencies:5};
  console.log(JSON.stringify(result));
  return result;
}
function syncGoogleCbuRates() {
  var lock=LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw Error('Sync already running');
  try {
    var p=PropertiesService.getScriptProperties();
    var secret=p.getProperty('CBU_SYNC_SHARED_SECRET');
    var url=p.getProperty('CBU_SYNC_TARGET_URL');
    if(!secret || Utilities.newBlob(secret).getBytes().length<32 ||
       !/^https:\/\/[^/?#]+\/api\/integrations\/cbu-rate-sync$/.test(url||'')) {
      throw Error('Secure CBU relay Script Properties not configured');
    }
    var quote=fxFetch();
    var raw=JSON.stringify({source:'CBU',fetchedAt:new Date().toISOString(),rates:quote.rates});
    var ts=String(Date.now());
    var bytes=Utilities.computeHmacSha256Signature(ts+'.'+raw,secret,Utilities.Charset.UTF_8);
    var hex=bytes.map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');
    var res=UrlFetchApp.fetch(url,{method:'post',contentType:'application/json',
      payload:raw,muteHttpExceptions:true,followRedirects:false,
      headers:{'X-CBU-Sync-Timestamp':ts,'X-CBU-Sync-Signature':'sha256='+hex}});
    if(res.getResponseCode()!==200) throw Error('Backend rejected CBU sync: HTTP '+res.getResponseCode());
    var ack=JSON.parse(res.getContentText('UTF-8'));
    if(ack.accepted!==true || ack.date!==quote.day || ack.currencies!==5) throw Error('Invalid CBU sync acknowledgement');
    console.log(JSON.stringify({status:'CBU_SYNC_OK',day:quote.day,currencies:5}));
  } finally {lock.releaseLock();}
}
function installCbuTrigger() {
  var exists=ScriptApp.getProjectTriggers().some(function(t){return t.getHandlerFunction()==='syncGoogleCbuRates';});
  if(!exists) ScriptApp.newTrigger('syncGoogleCbuRates').timeBased().everyMinutes(30).create();
  return {installed:!exists};
}
function stopCbuTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t){
    if(t.getHandlerFunction()==='syncGoogleCbuRates') ScriptApp.deleteTrigger(t);
  });
}
