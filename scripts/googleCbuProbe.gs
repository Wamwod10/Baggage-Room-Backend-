// Execute in Google Apps Script once to verify official CBU access.
function probeCbu() {
  var url = 'https://cbu.uz/uz/arkhiv-kursov-valyut/json/';
  var response = UrlFetchApp.fetch(url, {muteHttpExceptions:true});
  if (response.getResponseCode() !== 200) throw new Error('CBU HTTP '+response.getResponseCode());
  var data = JSON.parse(response.getContentText());
  var rub = data.find(function(x){return x.Ccy === 'RUB';});
  if (!rub || !rub.Rate || !rub.Date) throw new Error('CBU RUB data missing');
  console.log(JSON.stringify({connected:true,source:'CBU',effectiveDate:rub.Date}));
}
