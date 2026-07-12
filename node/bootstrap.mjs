// Node.js の worker_threads 上で、ブラウザ (Web Worker) 前提の共通スクリプト
// (common/*.js) を動かすための配線。
import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// postMessage をグローバルに配線する (共通スクリプトが直接呼ぶため)
export function wireWorkerGlobals() {
  globalThis.self = globalThis; // UMD バンドルが引数として self を評価するため
  globalThis.postMessage = (msg) => parentPort.postMessage(msg);
  // worker は Atomics.wait で頻繁にブロックするため、stdout パイプ経由の
  // console 出力は壊れる (フラッシュされず NUL 化する)。親スレッドに委譲する。
  const send = (...a) => parentPort.postMessage({
    type: "log",
    line: a.map((v) => (typeof v === "string" ? v : String(v))).join(" "),
  });
  console.log = send;
  console.error = send;
  console.warn = send;
}

// browser_wasi_shim (UMD) を CJS として読み、エクスポートをグローバルに生やす
export function loadShimGlobals() {
  const require = createRequire(import.meta.url);
  Object.assign(globalThis, require("../browser_wasi_shim/index.js"));
  Object.assign(globalThis, require("../browser_wasi_shim/wasi_defs.js"));
}

// importScripts 相当: classic スクリプトをグローバルスコープで実行する
export function importScript(rel) {
  const p = fileURLToPath(new URL(rel, import.meta.url));
  vm.runInThisContext(readFileSync(p, "utf8"), { filename: p });
}
