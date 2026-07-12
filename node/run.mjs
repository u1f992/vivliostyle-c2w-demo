#!/usr/bin/env node
// container2wasm で変換した vivliostyle イメージを Node.js で実行するドライバ。
// ブラウザデモと同じ共通コア (common/) と c2w-net-proxy によるネットワーク
// スタックを worker_threads で動かす。HTTP/HTTPS は Node の fetch で外部へ
// 転送されるため、Web フォント (Google Fonts など) も取得できる。
//
// Node.js 24 以上で実行すること。ホストにない場合は Docker で:
//
//   docker run --rm -v "$PWD:/w" node:24 \
//     node /w/node/run.mjs --data /w/work -- build manuscript.md -o out.pdf -t 3600
//
// 使い方:
//   node run.mjs [オプション] [--] [ARG...]
//
// ARG... はコンテナのエントリポイント (このイメージでは vivliostyle) への引数になる。
// コンテナ側に `-` で始まる引数を渡すときは `--` で区切ること。
//
// オプション:
//   --wasm <path>        実行する wasm (既定: ../out.wasm)
//   --proxy-wasm <path>  c2w-net-proxy.wasm (既定: ../c2w-net-proxy.wasm)
//   --data <hostdir>     ゲストの /data にするディレクトリ。実行前にメモリ内 FS へ
//                        読み込み、実行後に書き戻す
//   --env <KEY=VALUE>    コンテナに渡す環境変数 (複数指定可)
//   --entrypoint <cmd>   エントリポイントを差し替える
//   --stdin              stdin を有効にする (既定は --no-stdin を付与)
//   --raw-command        vivliostyle 用プロキシ引数 (--proxy-server など) を
//                        コマンドに自動追加しない (vivliostyle 以外を動かす場合)
//   --debug              WASI 呼び出しの調査ログを出す
//   -h, --help           このヘルプ

import { Worker } from "node:worker_threads";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const { values, positionals } = parseArgs({
  options: {
    wasm: { type: "string", default: path.join(HERE, "..", "out.wasm") },
    "proxy-wasm": { type: "string", default: path.join(HERE, "..", "c2w-net-proxy.wasm") },
    data: { type: "string" },
    env: { type: "string", multiple: true, default: [] },
    entrypoint: { type: "string" },
    stdin: { type: "boolean", default: false },
    "raw-command": { type: "boolean", default: false },
    debug: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  console.log(src.split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}

for (const p of [values.wasm, values["proxy-wasm"]]) {
  if (!existsSync(p)) {
    console.error(`ファイルがありません: ${p}\n` +
      "out.wasm は fetch-wasm.sh (デプロイ済み Pages から復元) か c2w での変換で、\n" +
      "c2w-net-proxy.wasm は container2wasm のリリースから用意してください。");
    process.exit(2);
  }
}

// connect (worker 間のリングバッファ結線) を common/stack.js から読み込む
globalThis.self = globalThis;
vm.runInThisContext(
  readFileSync(path.join(HERE, "..", "common", "stack.js"), "utf8"),
  { filename: "common/stack.js" });

const vmWorker = new Worker(new URL("./vm-worker.mjs", import.meta.url), {
  workerData: { wasmPath: path.resolve(values.wasm) },
});
const stackWorker = new Worker(new URL("./stack-worker.mjs", import.meta.url));

// ブラウザ版 stack.js の newStack と同じ結線を worker_threads で行う
const p2vbuf = { buf: new Uint8Array(0) }; // proxy -> vm
const v2pbuf = { buf: new Uint8Array(0) }; // vm -> proxy
const certbuf = { buf: new Uint8Array(0), done: false };
const proxyShared = new SharedArrayBuffer(12 + 4096);
const vmShared = new SharedArrayBuffer(12 + 4096);
const proxyHandler = globalThis.connect("proxy", proxyShared,
  { sendbuf: p2vbuf, recvbuf: v2pbuf }, certbuf);
const vmNetHandler = globalThis.connect("vm", vmShared,
  { sendbuf: v2pbuf, recvbuf: p2vbuf }, certbuf);
// connect のハンドラは this にタイマー状態を持つ (ブラウザでは this=worker)。
// 2 つのハンドラで状態が混ざらないよう、個別の this を与える。
const proxyThis = {};
const vmThis = {};
// 調査用: worker 間メッセージの流量統計 (DEBUG_STATS=1 のとき 10 秒ごとに表示)
const stats = {};
const count = (tag, data) => {
  if (!process.env.DEBUG_STATS) return;
  const k = tag + ":" + (data && data.type ? data.type : typeof data);
  stats[k] = (stats[k] ?? 0) + 1;
};
if (process.env.DEBUG_STATS) {
  setInterval(() => {
    console.error("[stats]", JSON.stringify(stats));
  }, 10000).unref();
}
for (const [w, name] of [[vmWorker, "vm"], [stackWorker, "stack"]]) {
  w.on("error", (e) => {
    console.error(`[run.mjs] ${name} worker error:`, e);
    shutdown(1);
  });
  w.on("exit", (code) => {
    if (code !== 0 && !shuttingDown) {
      console.error(`[run.mjs] ${name} worker exited with code ${code}`);
      shutdown(1);
    }
  });
}
stackWorker.on("message", (data) => {
  if (data && data.type === "log") {
    console.error("[net]", data.line);
    return;
  }
  count("proxy", data);
  proxyHandler.call(proxyThis, { data });
});
stackWorker.postMessage({ type: "init", buf: proxyShared,
  imagename: path.resolve(values["proxy-wasm"]) });

vmWorker.on("message", (data) => {
  if (data && typeof data === "object") {
    switch (data.type) {
      case "log":
        console.error(data.line);
        return;
      case "done":
        console.error("[run.mjs] done");
        shutdown(0);
        return;
      case "error":
        console.error("[run.mjs] error:", data.message);
        shutdown(1);
        return;
    }
  }
  count("vm", data);
  vmNetHandler.call(vmThis, { data });
});
vmWorker.postMessage({ type: "init", buf: vmShared });

console.error(`[run.mjs] loading ${values.wasm}`);
vmWorker.postMessage({
  dataHostDir: values.data ? path.resolve(values.data) : null,
  containerArgs: positionals,
  addProxyArgs: !values["raw-command"],
  entrypoint: values.entrypoint,
  extraEnv: values.env,
  stdin: values.stdin,
  debugTrace: values.debug,
});

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return; // terminate による worker exit との競合を防ぐ
  shuttingDown = true;
  Promise.allSettled([vmWorker.terminate(), stackWorker.terminate()])
    .then(() => process.exit(code));
}
