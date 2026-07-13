// ブラウザ用エントリ: c2w-net-proxy.wasm を fetch して共通コア (net-stack.js) で
// 起動する。
importScripts("browser_wasi_shim/index.js");
importScripts("browser_wasi_shim/wasi_defs.js");
importScripts("common/worker-util.js");
importScripts("common/wasi-util.js");
importScripts("common/net-stack.js");

onmessage = (msg) => {
    if (serveIfInitMsg(msg)) {
        fetch(getImagename(), { credentials: 'same-origin' })
            .then((resp) => resp.arrayBuffer())
            .then((wasm) => startNetStack(wasm));
    }
};
