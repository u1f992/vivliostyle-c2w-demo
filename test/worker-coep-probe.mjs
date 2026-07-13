// H1 検証: navigate-only SW (site/ 現状) の下で dedicated worker が
// COEP 互換性チェックによりブロックされるかを測定する。
// - Network.loadingFailed の blockedReason を記録
// - new Worker() の onerror/onmessage/timeout を判定
import { createServer } from "node:http";
import { createReadStream, readdirSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire("/opt/vivliostyle-cli/package.json");
const puppeteer = require("puppeteer-core");

const HTDOCS = process.env.HTDOCS ?? "/w/site";
const PORT = 8080;
const BASE = "/vivliostyle-c2w-demo";
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
const page = await browser.newPage();
page.on("console", (m) => { const t = m.text(); if (!t.includes("PACKET")) console.log("[page]", t.slice(0, 300)); });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

const client = await page.target().createCDPSession();
await client.send("Network.enable");
const reqUrls = new Map();
client.on("Network.requestWillBeSent", (e) => reqUrls.set(e.requestId, e.request.url));
client.on("Network.loadingFailed", (e) => {
  console.log("[loadingFailed]", JSON.stringify({
    url: reqUrls.get(e.requestId), errorText: e.errorText,
    blockedReason: e.blockedReason, type: e.type,
  }));
});

await page.goto(`http://127.0.0.1:${PORT}${BASE}/`, { waitUntil: "load", timeout: 120000 });
for (let i = 0; i < 8; i++) {
  try { if (await page.evaluate("window.crossOriginIsolated === true")) break; } catch {}
  await new Promise((r) => setTimeout(r, 3000));
  try { await page.reload({ waitUntil: "load", timeout: 60000 }); } catch {}
}
console.log("isolated:", await page.evaluate("window.crossOriginIsolated").catch(() => "?"),
  "controller:", await page.evaluate("!!navigator.serviceWorker.controller").catch(() => "?"));

// 明示的に worker を起動し、結果イベントを観測する
const verdict = await page.evaluate(() => new Promise((res) => {
  const w = new Worker("demo-worker.js");
  w.onerror = (e) => res("WORKER_ERROR: " + (e.message ?? "(no message)"));
  w.onmessage = (m) => res("WORKER_MESSAGE: " + JSON.stringify(m.data).slice(0, 100));
  setTimeout(() => res("TIMEOUT (no event in 20s)"), 20000);
}));
console.log("VERDICT:", verdict);
await new Promise((r) => setTimeout(r, 1000));
await browser.close();
server.close();
