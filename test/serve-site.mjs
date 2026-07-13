// site/ を 0.0.0.0:8080 でサブパス配信する (ブリッジ経由の検証用)。
// Range リクエストに対応する (GitHub Pages/Fastly も対応しており、
// demo-worker.js の再開処理の検証に必要)。
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";

const HTDOCS = process.env.HTDOCS ?? "/w/site";
const PORT = 8080;
const BASE = "/vivliostyle-c2w-demo";
// wasm パーツの配信帯域 (bytes/sec)。0 で無制限。実 CDN のように数分かかる
// ダウンロード中の障害を検証するために絞る。
const THROTTLE_BPS = Number(process.env.THROTTLE_BPS ?? 0);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript",
  ".wasm": "application/wasm", ".json": "application/json" };

async function pipeThrottled(stream, res, bps) {
  const chunkMs = 50;
  const perChunk = Math.max(1, Math.round((bps * chunkMs) / 1000));
  try {
    for await (const chunk of stream) {
      for (let i = 0; i < chunk.length; i += perChunk) {
        const slice = chunk.subarray(i, i + perChunk);
        if (!res.write(slice)) await new Promise((r) => res.once("drain", r));
        await new Promise((r) => setTimeout(r, chunkMs));
      }
    }
    res.end();
  } catch {
    res.destroy();
  }
}

createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (!p.startsWith(BASE + "/") && p !== BASE) { res.writeHead(404); res.end(); return; }
  p = p.slice(BASE.length);
  if (p === "" || p === "/") p = "/index.html";
  const file = path.join(HTDOCS, p);
  if (!file.startsWith(HTDOCS) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  const size = statSync(file).size;
  const type = MIME[path.extname(file)] ?? "application/octet-stream";
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : size - 1;
    if (start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
    });
    const rs = createReadStream(file, { start, end });
    if (THROTTLE_BPS && p.includes("/wasm/")) pipeThrottled(rs, res, THROTTLE_BPS);
    else rs.pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": size,
    "Accept-Ranges": "bytes" });
  const rs = createReadStream(file);
  if (THROTTLE_BPS && p.includes("/wasm/")) pipeThrottled(rs, res, THROTTLE_BPS);
  else rs.pipe(res);
}).listen(PORT, "0.0.0.0", () => console.log(`serving ${HTDOCS} on 0.0.0.0:${PORT}`));
