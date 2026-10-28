// Read-only network diagnostic for Render Frankfurt; never imports the application or reads DATABASE_URL.
// This temporary service must run on the free plan, with auto deploy disabled and no secrets.
const http = require("node:http");

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const urls = [
  `https://cbu.uz/uz/arkhiv-kursov-valyut/json/all/${today}/`,
  "https://cbu.uz/uz/arkhiv-kursov-valyut/json/",
  "https://www.cbu.uz/uz/arkhiv-kursov-valyut/json/",
  "https://cbu.uz/ru/arkhiv-kursov-valyut/json/",
];
async function runForcedIpv4(url) {
  const https = require("node:https");
  return new Promise(resolve => {
    const req = https.get(url, {
      family: 4, timeout: 10000, headers: { Accept: "application/json" },
    }, response => {
      let raw = "";
      response.on("data", chunk => {
        raw += chunk.toString("utf8");
        if (raw.length > 500000) req.destroy(new Error("Response too large"));
      });
      response.on("end", () => {
        try {
          const data = JSON.parse(raw);
          const rub = Array.isArray(data) ? data.find(row => row.Ccy === "RUB") : null;
          const usd = Array.isArray(data) ? data.find(row => row.Ccy === "USD") : null;
          resolve({ status: response.statusCode, reachable: response.statusCode === 200 && Boolean(rub?.Rate && usd?.Rate),
            effectiveDate: rub?.Date || null, rate: rub?.Rate || null });
        } catch (error) { resolve({ reachable:false, error: error.name }); }
      });
    });
    req.once("error", error => resolve({ reachable:false, error:error.name, code:error.code || null }));
    req.once("timeout", () => req.destroy(new Error("IPv4 Timeout")));
  });
}
async function runMirrorDiagnostic() {
  const url = "https://apicloud.uz/v1/currency/rates?valyuta=RUB";
  try {
    const response = await fetch(url,{signal:AbortSignal.timeout(8500),headers:{Accept:"application/json"}});
    const body = await response.json();
    // Diagnostic only. Do not trust or ingest third-party rate data into any payment table.
    const entry = body?.valyuta || body?.data?.valyuta || body?.data || {};
    console.log(JSON.stringify({diagnostic:"CBU_UNTRUSTED_MIRROR_CONNECTIVITY",
      vendor:"apicloud.uz",reachable:response.ok,status:response.status,
      hasRate:Number.isFinite(Number(entry.kurs ?? entry.rate)),
      hasEffectiveDate:Boolean(entry.sana || entry.date || entry.Date || body?.sana || body?.date || body?.Date),
    }));
  } catch(error) { console.log(JSON.stringify({diagnostic:"CBU_UNTRUSTED_MIRROR_CONNECTIVITY",
    vendor:"apicloud.uz",reachable:false,error:error?.name||"Error"})); }
}
async function run() {
  for (const url of urls) {
    const path = new URL(url).pathname;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(9000),
        headers: { Accept: "application/json" },
      });
      const body = await response.json();
      const rub = Array.isArray(body) ? body.find(x => x.Ccy === "RUB") : null;
      const usd = Array.isArray(body) ? body.find(x => x.Ccy === "USD") : null;
      console.log(JSON.stringify({
        diagnostic: "CBU_FRANKFURT_PROBE", path, httpStatus: response.status,
        valid: response.ok && Boolean(rub && usd),
        rubRate: rub?.Rate ?? null, usdRate: usd?.Rate ?? null,
        publishedDate: rub?.Date ?? null,
      }));
      if (response.ok && rub && usd) {
        console.log(JSON.stringify({ diagnostic: "CBU_FRANKFURT_PROBE_RESULT", reachable: true }));
        return;
      }
    } catch (error) {
      console.log(JSON.stringify({
        diagnostic: "CBU_FRANKFURT_PROBE", path, error: error?.name || "Error",
        cause: error?.cause?.code || null,
      }));
    }
  }
  const ipv4 = await runForcedIpv4("https://cbu.uz/uz/arkhiv-kursov-valyut/json/");
  console.log(JSON.stringify({ diagnostic: "CBU_FORCED_IPV4_RESULT", ...ipv4 }));
  console.log(JSON.stringify({ diagnostic: "CBU_FRANKFURT_PROBE_RESULT", reachable: ipv4.reachable }));
  await runMirrorDiagnostic();
}
// A minimal listener satisfies Render web health requirements; no DB, credentials or customer data.
http.createServer((req, res) => {
  res.writeHead(req.url === "/health" ? 200 : 404, {
    "Content-Type": "application/json", "Cache-Control": "no-store",
  });
  res.end(req.url === "/health" ? '{"status":"probe-only"}' : '{"error":"not-found"}');
}).listen(Number(process.env.PORT || 10000), "0.0.0.0", () => {
  console.log(JSON.stringify({ diagnostic: "CBU_FRANKFURT_PROBE_STARTED" }));
  run().catch(error => console.log(JSON.stringify({ diagnostic: "CBU_FRANKFURT_PROBE_FATAL", error: error?.name || "Error" })));
});
