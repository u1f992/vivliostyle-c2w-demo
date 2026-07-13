// site/ を HTTPS/HTTP2 でサブパス配信する (ブリッジ経由の検証用)。
// ERR_NETWORK_CHANGED は HTTP/2 セッションを閉じる (HTTP/1.1 の転送は
// 生き残ることを実測済み) ため、実 Pages と同じ h2 で検証する必要がある。
// Range リクエスト対応と wasm パーツの帯域制限は serve-site.mjs と同じ。
import { createSecureServer } from "node:http2";
import { createReadStream, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const HTDOCS = process.env.HTDOCS ?? "/w/site";
const PORT = 8443;
const BASE = "/vivliostyle-c2w-demo";
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

createSecureServer({
  key: readFileSync("/w/test/tls/key.pem"),
  cert: readFileSync("/w/test/tls/cert.pem"),
  allowHTTP1: true,
}, (req, res) => {
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
  const throttle = THROTTLE_BPS && p.includes("/wasm/");
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
    if (throttle) pipeThrottled(rs, res, THROTTLE_BPS);
    else rs.pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": size,
    "Accept-Ranges": "bytes" });
  const rs = createReadStream(file);
  if (throttle) pipeThrottled(rs, res, THROTTLE_BPS);
  else rs.pipe(res);
}).listen(PORT, "0.0.0.0", () => console.log(`serving ${HTDOCS} on 0.0.0.0:${PORT} (h2)`));
