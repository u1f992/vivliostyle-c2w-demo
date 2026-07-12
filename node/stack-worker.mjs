// Node.js 用エントリ: c2w-net-proxy.wasm (ネットワークスタック) を
// worker_threads 内で起動する。本体は共通コア (common/net-stack.js)。
// HTTP/HTTPS の外部転送は Node の fetch (undici) が担うため、ブラウザ版と
// 違って CORS の制約を受けない。
import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { wireWorkerGlobals, loadShimGlobals, importScript } from "./bootstrap.mjs";

wireWorkerGlobals();
loadShimGlobals();
importScript("../common/worker-util.js");
importScript("../common/wasi-util.js");
importScript("../common/net-stack.js");

parentPort.on("message", (data) => {
  if (globalThis.serveIfInitMsg({ data })) {
    // init の imagename には c2w-net-proxy.wasm のホストパスが入っている
    globalThis.startNetStack(readFileSync(globalThis.getImagename()));
  }
});
