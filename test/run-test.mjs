// ブラウザ版デモの自動検証。vivliostyle-slim-root イメージ内で実行する前提:
//
//   docker run --rm -v "$PWD:/w" --entrypoint node vivliostyle-slim-root \
//     /w/test/run-test.mjs
//
// イメージに同梱の Chrome と puppeteer-core を使い、デモページを開いて
// Build PDF を押し、生成された PDF を test/browser.pdf に保存する。
import { createServer } from "node:http";
import { createReadStream, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire("/opt/vivliostyle-cli/package.json");
const puppeteer = require("puppeteer-core");

const HTDOCS = process.env.HTDOCS ?? "/w";
const OUT = process.env.OUT_PDF ?? "/w/test/browser.pdf";
const PORT = 8080;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(HTDOCS, p);
  if (!file.startsWith(HTDOCS) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": statSync(file).size,
  });
  createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
console.log(`serving ${HTDOCS} on :${PORT}`);

const chromeBase = "/opt/puppeteer/chrome";
const chromeVer = readdirSync(chromeBase)[0];
const executablePath = path.join(chromeBase, chromeVer, "chrome-linux64", "chrome");
console.log(`chrome: ${executablePath}`);

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  protocolTimeout: 45 * 60 * 1000,
});
const page = await browser.newPage();
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("PACKET")) return; // c2w-net-proxy --debug のパケットダンプは捨てる
  console.log("[page]", t);
});
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

async function waitFor(label, fn, timeoutMs, pollMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // coi-serviceworker のリロードで evaluate が失敗しうるためリトライする
    try {
      if (await fn()) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load", timeout: 120000 });

// coi-serviceworker のリロードが service worker の activate と競合して
// 制御が付かないことがあるため、isolation が付くまでリロードを繰り返す
for (let i = 0; i < 6; i++) {
  try {
    if (await page.evaluate("window.crossOriginIsolated === true")) break;
    const state = await page.evaluate(
      "({ coi: window.crossOriginIsolated, ctrl: !!navigator.serviceWorker?.controller })");
    console.log(`isolation attempt ${i}:`, JSON.stringify(state));
    if (i === 5) throw new Error("crossOriginIsolated did not become true");
    await new Promise((r) => setTimeout(r, 3000));
    await page.reload({ waitUntil: "load", timeout: 60000 });
  } catch (e) {
    if (String(e).includes("did not become")) throw e;
    // リロード中の evaluate 失敗はリトライ
    await new Promise((r) => setTimeout(r, 2000));
  }
}
console.log("crossOriginIsolated: ok");

await waitFor("wasm loaded (build button enabled)",
  () => page.evaluate('!document.getElementById("build").disabled'), 15 * 60 * 1000);
console.log("wasm loaded");

const rawArgs = process.env.RAW_ARGS ? JSON.parse(process.env.RAW_ARGS) : null;
if (rawArgs) {
  console.log("running raw args:", JSON.stringify(rawArgs));
  const rawManuscript = process.env.RAW_MANUSCRIPT
    ? (await import("node:fs")).readFileSync(process.env.RAW_MANUSCRIPT, "utf8") : "";
  await page.evaluate((a, m) => window.__runRaw(a, m), rawArgs, rawManuscript);
} else if (process.env.NO_NODE_PROXY) {
  console.log("building with noNodeProxy");
  await page.evaluate(() => window.__buildWith({ noNodeProxy: true }));
} else {
  await page.click("#build");
}
console.log("build started");

await waitFor("build finished",
  () => page.evaluate("!!(window.__pdfBlob || window.__pdfError)"), 40 * 60 * 1000, 5000);

const err = await page.evaluate("window.__pdfError ?? null");
if (err) {
  await browser.close();
  server.close();
  if (rawArgs) {
    console.log("raw run finished (no out.pdf expected):", err);
    process.exit(0);
  }
  throw new Error("build failed: " + err);
}

const b64 = await page.evaluate(async () => {
  const buf = await window.__pdfBlob.arrayBuffer();
  const u8 = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
});
writeFileSync(OUT, Buffer.from(b64, "base64"));
console.log(`saved ${OUT} (${Buffer.from(b64, "base64").length} bytes)`);

await browser.close();
server.close();
