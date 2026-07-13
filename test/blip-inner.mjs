// コンテナ内プローブ: 実 Pages から wasm をダウンロードしつつ status を逐次
// ログする。ホスト側が docker logs を監視し、進行中にアドレス変化を注入する。
// 観察後にリロードし、navigate が生きているかも報告する。
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire("/opt/vivliostyle-cli/package.json");
const puppeteer = require("puppeteer-core");

const TARGET = process.env.TARGET_URL ?? "https://u1f992.github.io/vivliostyle-c2w-demo/";

const chromeBase = "/opt/puppeteer/chrome";
const executablePath = path.join(chromeBase, readdirSync(chromeBase)[0], "chrome-linux64", "chrome");
const args = ["--no-sandbox", "--disable-dev-shm-usage"];
// ブリッジ配信 (http:// または自己署名証明書の https://) でも Service Worker
// を登録できるようにする
if (TARGET.startsWith("http://")) {
  args.push(`--unsafely-treat-insecure-origin-as-secure=${new URL(TARGET).origin}`);
} else if (!TARGET.includes("github.io")) {
  args.push("--ignore-certificate-errors");
}
const browser = await puppeteer.launch({ executablePath, headless: true, args });

browser.on("targetcreated", async (t) => {
  if (t.type() !== "service_worker") return;
  try {
    const s = await t.createCDPSession();
    await s.send("Runtime.enable");
    s.on("Runtime.consoleAPICalled", (e) => {
      const args = e.args.map((a) => a.value ?? a.description ?? "").join(" ");
      console.log(`[SW:${e.type}]`, args.slice(0, 200));
    });
    s.on("Runtime.exceptionThrown", (e) => {
      console.log("[SW:exception]", (e.exceptionDetails.exception?.description ?? "").slice(0, 150));
    });
  } catch {}
});

const page = await browser.newPage();
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("PACKET")) return;
  if (/network error|Failed to fetch|Failed to convert/i.test(t)) console.log("[page!]", t.slice(0, 250));
});

console.log("target:", TARGET);
await page.goto(TARGET, { waitUntil: "load", timeout: 120000 });
for (let i = 0; i < 8; i++) {
  try { if (await page.evaluate("window.crossOriginIsolated === true")) break; } catch {}
  await new Promise((r) => setTimeout(r, 3000));
  try { await page.reload({ waitUntil: "load", timeout: 60000 }); } catch {}
}
console.log("isolated:", await page.evaluate("window.crossOriginIsolated").catch(() => "?"));

// 最大 8 分、status の変化を逐次ログ (ホストはこれを見て注入タイミングを決める)
let last = "";
const deadline = Date.now() + 8 * 60 * 1000;
let outcome = "TIMEOUT";
while (Date.now() < deadline) {
  const st = await page.evaluate(() => ({
    status: document.getElementById("status")?.textContent ?? "",
    ready: !document.getElementById("build")?.disabled,
  })).catch(() => null);
  if (st) {
    if (st.status !== last) { last = st.status; console.log("[status]", st.status.slice(0, 150)); }
    // エラー表示を先に判定する (旧 main.js はエラー後もボタンを有効化するため)
    if (st.status.startsWith("エラー")) { outcome = "WORKER_ERROR: " + st.status.slice(0, 150); break; }
    if (st.ready && st.status.includes("ロード完了")) { outcome = "COMPLETED"; break; }
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log("DOWNLOAD_OUTCOME:", outcome);

// 注入後のリロードで navigate が死ぬかを確認
try {
  await page.reload({ waitUntil: "load", timeout: 90000 });
  const alive = await page.evaluate(() => !!document.getElementById("status")).catch(() => false);
  console.log("RELOAD_OUTCOME:", alive ? "alive" : "DEAD_PAGE");
} catch (e) {
  console.log("RELOAD_OUTCOME: NAVIGATE_DIED:", String(e).slice(0, 150));
}
await browser.close();
