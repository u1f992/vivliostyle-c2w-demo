// ブラウザ用エントリ: container2wasm で変換した vivliostyle イメージを
// Web Worker 内で実行する。VM の実行や WASI shim へのパッチは共通コア
// (common/vm-runner.js) にあり、Node.js 版 (node/vm-worker.mjs) と共用する。
"use strict";

importScripts("browser_wasi_shim/index.js");
importScripts("browser_wasi_shim/wasi_defs.js");
importScripts("common/worker-util.js"); // sock*/recvCert/getCertDir/wasiHackSocket
importScripts("common/wasi-util.js"); // poll_oneoff 用 Subscription/Event 定義
importScripts("common/vm-runner.js"); // runC2w + shim パッチ群

// wasm の取得: worker URL の ?wasm=<url> があれば単体ファイル (非圧縮) を、
// なければ wasm-manifest.json に列挙された gzip 分割パーツを結合して使う。
// 分割は GitHub の 100MB/ファイル制限との折り合いのため (make-parts.sh で生成)。
// 起動直後からロードを始め、Module を保持するので 2 回目以降のビルドは
// instantiate だけで済む。
const wasmOverride = new URLSearchParams(self.location.search).get("wasm");

// ダウンロードは数分に及ぶため、その間に OS のネットワーク変化 (VPN/docker/
// DHCP 更新等) が一度でも起きると、Chrome は全接続を ERR_NETWORK_CHANGED で
// 破棄し、進行中の fetch と body の読み取りが reject する (netlog で実測)。
// gzip ストリームは逐次伸長で先頭からやり直せないので、中断オフセットからの
// Range リクエストで再開する。進捗があれば試行回数はリセットする。
async function fetchPartInto(url, writer, onBytes) {
  let offset = 0;
  let attempt = 0;
  for (;;) {
    let progressed = false;
    try {
      const opts = { credentials: "same-origin" };
      // 再試行はキャッシュ競合 (ERR_CACHE_RACE) を避けるため no-store で取り直す
      if (attempt > 0) opts.cache = "no-store";
      if (offset > 0) opts.headers = { Range: `bytes=${offset}-` };
      const resp = await fetch(url, opts);
      if (offset > 0 && resp.status === 416) return; // 既に末尾まで取得済み
      if (!resp.ok && resp.status !== 206) {
        throw new Error(`failed to fetch ${url}: ${resp.status}`);
      }
      // サーバが Range を無視して 200 を返した場合は取得済み分を読み捨てる
      let skip = offset > 0 && resp.status === 200 ? offset : 0;
      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        let chunk = value;
        if (skip > 0) {
          if (chunk.byteLength <= skip) { skip -= chunk.byteLength; continue; }
          chunk = chunk.subarray(skip);
          skip = 0;
        }
        await writer.write(chunk);
        offset += chunk.byteLength;
        progressed = true;
        onBytes(chunk.byteLength);
      }
    } catch (e) {
      if (progressed) attempt = 0;
      if (++attempt > 5) throw e;
      postMessage({ type: "log",
        line: `接続が中断されました。再開します（${(offset / 2 ** 20).toFixed(1)} MiB取得済み、${attempt}回目）…` });
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function fetchWithRetry(url, init) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
    try {
      return await fetch(url, attempt === 0 ? init : { ...init, cache: "no-store" });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function loadModule() {
  if (wasmOverride) {
    const resp = await fetchWithRetry(wasmOverride, { credentials: "same-origin" });
    if (!resp.ok) throw new Error(`failed to fetch ${wasmOverride}: ${resp.status}`);
    return WebAssembly.compile(await resp.arrayBuffer());
  }
  const manifest = await (await fetchWithRetry("wasm-manifest.json")).json();
  const ds = new DecompressionStream("gzip");
  const decompressed = new Response(ds.readable).arrayBuffer();
  const writer = ds.writable.getWriter();
  let loaded = 0;
  let lastReport = 0;
  for (const part of manifest.parts) {
    await fetchPartInto(part, writer, (n) => {
      loaded += n;
      if (loaded - lastReport > 16 * 1024 * 1024) {
        lastReport = loaded;
        postMessage({ type: "log",
          line: `wasmをロード中：${(loaded / 2 ** 20).toFixed(0)} MiB（圧縮）` });
      }
    });
  }
  await writer.close();
  const buf = await decompressed;
  postMessage({ type: "log",
    line: `伸長完了（${(buf.byteLength / 2 ** 20).toFixed(0)} MiB）。コンパイル中…` });
  return WebAssembly.compile(buf);
}

const modulePromise = loadModule();

modulePromise
  .then(() => postMessage({ type: "ready" }))
  .catch((e) => postMessage({ type: "error", message: String(e) }));

onmessage = (msg) => {
  if (serveIfInitMsg(msg)) {
    return; // stack.js からの init (SharedArrayBuffer の登録)
  }
  const { manuscript, rawArgs, noNodeProxy } = msg.data;
  modulePromise
    .then(async (module) => {
      const dataDir = new PreopenDirectory("/data", {
        "manuscript.md": new File(new TextEncoder().encode(manuscript ?? "")),
      });
      await runC2w({
        module,
        dataDir,
        containerArgs: ["build", "manuscript.md", "-o", "out.pdf", "-t", "3600",
          ...vivliostyleProxyArgs()],
        rawArgs,
        noNodeProxy,
      });
      const pdf = dataDir.dir.contents["out.pdf"];
      if (pdf && pdf.data && pdf.data.byteLength > 0) {
        const buf = pdf.data.buffer.slice(
          pdf.data.byteOffset, pdf.data.byteOffset + pdf.data.byteLength);
        postMessage({ type: "done", pdf: buf }, [buf]);
      } else {
        postMessage({ type: "error", message: "out.pdfが生成されませんでした（ログを確認してください）" });
      }
    })
    .catch((e) => postMessage({ type: "error", message: String(e) }));
};
