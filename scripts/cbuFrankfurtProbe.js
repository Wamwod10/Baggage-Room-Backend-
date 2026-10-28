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
  console.log(JSON.stringify({ diagnostic: "CBU_FRANKFURT_PROBE_RESULT", reachable: false }));
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
