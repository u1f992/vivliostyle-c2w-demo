// ブラウザ用エントリ: c2w-net-proxy.wasm を fetch して共通コア (net-stack.js) で
// 起動する。
importScripts("browser_wasi_shim/index.js");
importScripts("browser_wasi_shim/wasi_defs.js");
importScripts("common/worker-util.js");
importScripts("common/wasi-util.js");
importScripts("common/net-stack.js");

onmessage = (msg) => {
    if (serveIfInitMsg(msg)) {
        (async () => {
            // 一時的な接続破棄 (ERR_NETWORK_CHANGED 等) に備えて取り直す。
            // ここが無音で死ぬと、ビルドは動くのにネットワークだけ使えない
            // 分かりにくい状態になる。
            let lastErr;
            for (let attempt = 0; attempt < 4; attempt++) {
                if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
                try {
                    const resp = await fetch(getImagename(),
                        attempt === 0 ? { credentials: 'same-origin' }
                            : { credentials: 'same-origin', cache: 'no-store' });
                    if (!resp.ok) throw new Error(`failed to fetch ${getImagename()}: ${resp.status}`);
                    return startNetStack(await resp.arrayBuffer());
                } catch (e) {
                    lastErr = e;
                }
            }
            console.error('c2w-net-proxy.wasmの取得に失敗:', lastErr);
        })();
    }
};
