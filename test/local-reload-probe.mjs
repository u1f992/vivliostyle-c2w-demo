// H2 検証 (ローカル): passthrough SW の site/ をローカル配信し、wasm
// ダウンロード進行中のリロードで navigate の SW 内部 fetch が失敗するかを
// 反復測定する。HTTP/1.1 なので、再現しなければ H2/CDN 要因の切り分けになる。
import { createServer } from "node:http";
import { createReadStream, readdirSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire("/opt/vivliostyle-cli/package.json");
const puppeteer = require("puppeteer-core");

const HTDOCS = process.env.HTDOCS ?? "/w/site";
const PORT = 8080;
const BASE = "/vivliostyle-c2w-demo";
const CYCLES = Number(process.env.CYCLES ?? 15);
const THRESHOLD_MIB = Number(process.env.THRESHOLD_MIB ?? 32);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript",
  ".wasm": "application/wasm", ".json": "application/json" };

const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (!p.startsWith(BASE + "/") && p !== BASE) { res.writeHead(404); res.end(); return; }
  p = p.slice(BASE.length);
  if (p === "" || p === "/") p = "/index.html";
  const file = path.join(HTDOCS, p);
  if (!file.startsWith(HTDOCS) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": statSync(file).size });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const chromeBase = "/opt/puppeteer/chrome";
const executablePath = path.join(chromeBase, readdirSync(chromeBase)[0], "chrome-linux64", "chrome");
const browser = await puppeteer.launch({ executablePath, headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });

browser.on("targetcreated", async (t) => {
  if (t.type() !== "service_worker") return;
  try {
    const s = await t.createCDPSession();
    await s.send("Runtime.enable");
    s.on("Runtime.consoleAPICalled", (e) => {
      const args = e.args.map((a) => a.value ?? a.description ?? "").join(" ");
      console.log(`[SW:${e.type}]`, args.slice(0, 300));
    });
  } catch {}
});

const page = await browser.newPage();
let consoleBuf = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("PACKET")) return;
  consoleBuf.push(t);
  if (/network error|Failed to fetch|Failed to convert/i.test(t)) console.log("[page!]", t.slice(0, 300));
});

const cdp = await page.target().createCDPSession();
await cdp.send("Network.enable");

await page.goto(`http://127.0.0.1:${PORT}${BASE}/`, { waitUntil: "load", timeout: 120000 });
for (let i = 0; i < 8; i++) {
  try { if (await page.evaluate("window.crossOriginIsolated === true")) break; } catch {}
  await new Promise((r) => setTimeout(r, 3000));
  try { await page.reload({ waitUntil: "load", timeout: 60000 }); } catch {}
}
console.log("isolated:", await page.evaluate("window.crossOriginIsolated").catch(() => "?"));

let reproduced = 0;
for (let c = 0; c < CYCLES; c++) {
  const deadline = Date.now() + 3 * 60 * 1000;
  let seen = -1, ready = false;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => ({
      status: document.getElementById("status")?.textContent ?? "",
      ready: !document.getElementById("build")?.disabled,
    })).catch(() => null);
    if (st) {
      const m = st.status.match(/ロード中：(\d+) MiB/);
      if (m) seen = Number(m[1]);
      ready = st.ready;
      if (st.status.startsWith("エラー")) { console.log(`[cycle ${c}] page error state:`, st.status); break; }
    }
    if (seen >= THRESHOLD_MIB || ready) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`[cycle ${c}] progress=${seen}MiB ready=${ready} -> reload`);
  consoleBuf = [];
  try { await cdp.send("Network.clearBrowserCache"); } catch {}
  try {
    await page.reload({ waitUntil: "load", timeout: 90000 });
    const alive = await page.evaluate(() => !!document.getElementById("status")).catch(() => false);
    const errLogs = consoleBuf.filter((t) => /network error|Failed to fetch/i.test(t));
    if (!alive || errLogs.length) {
      reproduced++;
      console.log(`[cycle ${c}] REPRODUCED alive=${alive} errLogs=${JSON.stringify(errLogs.slice(0, 3))}`);
      if (!alive) break;
    } else {
      console.log(`[cycle ${c}] reload ok`);
    }
  } catch (e) {
    reproduced++;
    console.log(`[cycle ${c}] REPRODUCED reload threw:`, String(e).slice(0, 200));
    break;
  }
}
console.log(`RESULT: reproduced=${reproduced}/${CYCLES}`);
await browser.close();
server.close();
