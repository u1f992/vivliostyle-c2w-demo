// Node.js 用エントリ: container2wasm で変換した vivliostyle イメージを
// worker_threads 内で実行する。VM の実行や WASI shim へのパッチは共通コア
// (common/vm-runner.js) にあり、ブラウザ版 (demo-worker.js) と共用する。
//
// ゲストの /data は「ホストディレクトリを実行前にメモリ内 FS へ読み込み、
// 実行後に書き戻す」方式でマウントする。
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { wireWorkerGlobals, loadShimGlobals, importScript } from "./bootstrap.mjs";

wireWorkerGlobals();
loadShimGlobals();
importScript("../common/worker-util.js");
importScript("../common/wasi-util.js");
importScript("../common/vm-runner.js");

const modulePromise = WebAssembly.compile(readFileSync(workerData.wasmPath));

function dirToContents(hostDir) {
  const contents = {};
  for (const name of readdirSync(hostDir)) {
    const p = path.join(hostDir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      contents[name] = new globalThis.Directory(dirToContents(p));
    } else if (st.isFile()) {
      contents[name] = new globalThis.File(readFileSync(p));
    }
  }
  return contents;
}

function writeBack(dir, hostDir) {
  mkdirSync(hostDir, { recursive: true });
  for (const [name, entry] of Object.entries(dir.contents)) {
    if (name === "." || name === "..") continue;
    const p = path.join(hostDir, name);
    if (entry.contents) {
      writeBack(entry, p);
    } else if (entry.data) {
      writeFileSync(p, entry.data);
    }
  }
}

parentPort.on("message", async (data) => {
  if (globalThis.serveIfInitMsg({ data })) return;
  try {
    const { dataHostDir, containerArgs = [], addProxyArgs, entrypoint, extraEnv,
      stdin, rawArgs, debugTrace } = data;
    if (debugTrace) globalThis.DEBUG_TRACE = true;
    const args = [...containerArgs];
    if (addProxyArgs) args.push(...globalThis.vivliostyleProxyArgs());
    const module = await modulePromise;
    postMessage({ type: "log", line: "[vm-worker] module compiled" });
    const dataDir = new globalThis.PreopenDirectory("/data",
      dataHostDir ? dirToContents(dataHostDir) : {});
    await globalThis.runC2w({
      module, dataDir, containerArgs: args, entrypoint, extraEnv, stdin, rawArgs,
    });
    if (dataHostDir) writeBack(dataDir.dir, dataHostDir);
    postMessage({ type: "done" });
  } catch (e) {
    postMessage({ type: "error", message: String(e?.stack ?? e) });
  }
});
