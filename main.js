"use strict";

const btn = document.getElementById("build");
const statusEl = document.getElementById("status");
const manuscriptEl = document.getElementById("manuscript");

if (!window.crossOriginIsolated) {
  // coi-serviceworker の登録前 (初回ロード) はリロードで isolation が有効になる
  statusEl.textContent = "cross-origin isolationを有効化しています（自動リロードされます）";
}

// ページの ?wasm=<url> を worker に伝搬する (既定は wasm-manifest.json の
// gzip 分割パーツ。ローカル開発では ?wasm=out.wasm で単体ファイルを使える)
const worker = new Worker("demo-worker.js" + location.search);

// ネットワークスタック: c2w-net-proxy.wasm を別 worker で動かし、stack.js の
// newStack で VM worker と SharedArrayBuffer 越しに接続する。プロキシは VM の
// 切断で終了するため、ビルドのたびに張り直す。
let stackWorker = null;
let netHandler = null;
function startNet() {
  if (stackWorker) stackWorker.terminate();
  stackWorker = new Worker("stack-worker.js");
  netHandler = newStack(worker, "out.wasm", stackWorker, "c2w-net-proxy.wasm");
}
startNet();

const UI_TYPES = new Set(["ready", "log", "done", "error"]);

worker.onmessage = (msg) => {
  const d = msg.data;
  if (!d || !UI_TYPES.has(d.type)) {
    // socket / 証明書関連 (accept, send, recv, recv-is-readable, recv_cert...)
    if (netHandler) netHandler(msg);
    return;
  }
  switch (d.type) {
    case "ready":
      statusEl.textContent = "wasmのロード完了。Build PDFを押してください。";
      btn.disabled = false;
      break;
    case "log":
      statusEl.textContent = d.line;
      console.log(d.line);
      break;
    case "done": {
      const blob = new Blob([d.pdf], { type: "application/pdf" });
      window.__pdfBlob = blob; // 自動テスト用のフック
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "out.pdf";
      a.click();
      statusEl.textContent = `完了：out.pdf（${blob.size} bytes）をダウンロードしました`;
      btn.disabled = false;
      startNet(); // 次のビルドに備えてネットワークスタックを張り直す
      break;
    }
    case "error":
      statusEl.textContent = "エラー：" + d.message;
      window.__pdfError = d.message; // 自動テスト用のフック
      btn.disabled = false;
      startNet();
      break;
  }
};

btn.disabled = true;

// 自動テスト用: argv を差し替えて実行する (manuscript は /data/manuscript.md へ)
window.__runRaw = (rawArgs, manuscript) => {
  delete window.__pdfBlob;
  delete window.__pdfError;
  worker.postMessage({ rawArgs, manuscript });
};

// 自動テスト用: オプション付きで通常ビルドを実行する
window.__buildWith = (opts) => {
  delete window.__pdfBlob;
  delete window.__pdfError;
  worker.postMessage({ manuscript: manuscriptEl.value, ...(opts ?? {}) });
};

btn.addEventListener("click", () => {
  btn.disabled = true;
  delete window.__pdfBlob;
  delete window.__pdfError;
  statusEl.textContent = "VMを起動して組版しています（数分かかります）…";
  worker.postMessage({ manuscript: manuscriptEl.value });
});
