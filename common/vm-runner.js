// container2wasm で変換した vivliostyle イメージを browser_wasi_shim で実行する
// 共通コア。ブラウザ (Web Worker) と Node.js (worker_threads) の両方から使う。
//
// 前提グローバル (エントリ側で配線する):
// - browser_wasi_shim: WASI, File, Directory, PreopenDirectory, WHENCE_SET, Ciovec
// - wasi-util.js: Subscription, Event, EventType
// - worker-util.js: recvCert, getCertDir, wasiHackSocket, sockWaitForReadable, errStatus
// - postMessage (ブラウザ: worker ネイティブ / Node: parentPort への配線)
"use strict";

var DEBUG_TRACE = false; // エントリ側から上書き可 (WASI 呼び出しの調査ログ)

// c2w-net-proxy が提供するプロキシのアドレス (ゲストから見た仮想 IP)
const C2W_PROXY_URL = "http://192.168.127.253:80";
// socket 用に予約する fd (wasiHackSocket と --net=socket=listenfd= で共有)
const LISTEN_FD = 5;
const CONN_FD = 6;

// Atomics.wait による同期 sleep (ブラウザでは cross-origin isolation が必要)
const sleepArr = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms) {
  Atomics.wait(sleepArr, 0, 0, ms);
}

function genmac() {
  return "02:XX:XX:XX:XX:XX".replace(/X/g, () =>
    "0123456789ABCDEF".charAt(Math.floor(Math.random() * 16)));
}

// vivliostyle build に渡す、プロキシ (c2w-net-proxy) 前提の引数。
// --proxy-server: vivliostyle-cli が起動する Chrome にプロキシを渡す
// --ignore-https-errors: プロキシの動的証明書は Chrome の信頼ストアにないため
function vivliostyleProxyArgs() {
  return [
    `--proxy-server=${C2W_PROXY_URL}`,
    // vivliostyle-cli 自身のビューアサーバ (localhost) はプロキシを通さない
    "--proxy-bypass=localhost,127.0.0.1",
    "--ignore-https-errors", "--log-level", "verbose",
  ];
}

// この shim は filestat の ino を常に 0 で返すが、Bochs の 9p サーバは
// st_ino をそのまま qid.path (9p のファイル識別子) にするため、全ファイルの
// qid が衝突してゲスト Linux の v9fs が inode 不整合 (EINVAL) を起こす。
// File/Directory オブジェクトごとにユニークな ino を割り当てて上書きする。
const inoMap = new WeakMap();
let nextIno = 1n;
function inoOf(entry) {
  if (!entry || typeof entry !== "object") return 0n;
  let v = inoMap.get(entry);
  if (v === undefined) {
    v = nextIno++;
    inoMap.set(entry, v);
  }
  return v;
}

// mtime も shim は常に 0 を返す。v9fs は属性 (mtime/サイズ) の変化でキャッシュを
// 無効化するため、mtime が動かないと「書き込み前」のキャッシュ (サイズ 0 や
// 存在しないという negative dentry) が再検証をすり抜け、書いた直後のファイルが
// 読めない (ENOENT / 空読み) ことがある。書き込み操作のたびに進める。
const mtimeMap = new WeakMap();
function touchEntry(entry) {
  if (entry && typeof entry === "object") {
    mtimeMap.set(entry, BigInt(Date.now()) * 1000000n);
  }
}
function mtimeOf(entry) {
  if (!entry || typeof entry !== "object") return 0n;
  let v = mtimeMap.get(entry);
  if (v === undefined) {
    v = BigInt(Date.now()) * 1000000n;
    mtimeMap.set(entry, v);
  }
  return v;
}

function patchInode(wasi) {
  // filestat 構造体: ino は offset 8、nlink は offset 24 (いずれも u64)。
  // nlink はこの shim では常に 0 になるが、Linux にとって nlink=0 の inode は
  // 「削除済み」を意味し、v9fs の属性再検証の際にファイルが消えたと誤認されて
  // ENOENT/404 になることがあるため 1 に補正する。
  const fixStat = (buf, entry) => {
    const view = new DataView(wasi.inst.exports.memory.buffer);
    view.setBigUint64(buf + 8, inoOf(entry), true);
    if (view.getBigUint64(buf + 24, true) === 0n) {
      view.setBigUint64(buf + 24, 1n, true);
    }
    const t = mtimeOf(entry);
    view.setBigUint64(buf + 40, t, true); // atim
    view.setBigUint64(buf + 48, t, true); // mtim
    view.setBigUint64(buf + 56, t, true); // ctim
  };
  const _path_filestat_get = wasi.wasiImport.path_filestat_get;
  wasi.wasiImport.path_filestat_get = (fd, flags, path_ptr, path_len, buf) => {
    const ret = _path_filestat_get(fd, flags, path_ptr, path_len, buf);
    if (ret === 0) {
      const mem8 = new Uint8Array(wasi.inst.exports.memory.buffer);
      const path = new TextDecoder().decode(mem8.slice(path_ptr, path_ptr + path_len));
      const dirFd = wasi.fds[fd];
      const entry = dirFd && dirFd.dir ? dirFd.dir.get_entry_for_path(path) : null;
      fixStat(buf, entry);
    }
    return ret;
  };
  const _fd_filestat_get = wasi.wasiImport.fd_filestat_get;
  wasi.wasiImport.fd_filestat_get = (fd, buf) => {
    const ret = _fd_filestat_get(fd, buf);
    if (ret === 0) {
      const f = wasi.fds[fd];
      const entry = f ? (f.file ?? f.dir ?? f) : null;
      fixStat(buf, entry);
    }
    return ret;
  };

  // fd_readdir の dirent も d_ino が全エントリ 1 固定で返る。Bochs の 9p サーバは
  // これをそのまま Rreaddir の qid.path に流すため、lookup/getattr 経由の
  // ユニーク ino と矛盾し、ゲスト側で「readdir 直後のファイルが消える」dentry
  // 不整合が起きる (dev server のファイル監視が readdir するため時間依存で発症)。
  // 応答バッファ内の d_ino を stat 系と同じユニーク ino に書き換える。
  // dirent レイアウト: d_next u64@0, d_ino u64@8, d_namlen u32@16, d_type u8@20,
  // name @24
  const _fd_readdir = wasi.wasiImport.fd_readdir;
  wasi.wasiImport.fd_readdir = (fd, buf, buf_len, cookie, bufused_ptr) => {
    const ret = _fd_readdir(fd, buf, buf_len, cookie, bufused_ptr);
    if (ret === 0) {
      const view = new DataView(wasi.inst.exports.memory.buffer);
      const mem8 = new Uint8Array(wasi.inst.exports.memory.buffer);
      const used = view.getUint32(bufused_ptr, true);
      const f = wasi.fds[fd];
      const dir = f && f.dir ? f.dir : null;
      let p = buf;
      const end = buf + used;
      while (p + 24 <= end) {
        const namlen = view.getUint32(p + 16, true);
        if (p + 24 + namlen > end) break; // 末尾の切り詰められたエントリ
        const name = new TextDecoder().decode(mem8.slice(p + 24, p + 24 + namlen));
        if (name === "." || name === "..") {
          // preopen ルートの qid.path は Bochs 側で 0 固定のため、それに合わせる
          view.setBigUint64(p + 8, 0n, true);
        } else if (dir && dir.contents[name]) {
          view.setBigUint64(p + 8, inoOf(dir.contents[name]), true);
        }
        p += 24 + namlen;
      }
    }
    return ret;
  };
}

// wasm32 の i32 引数は JS には符号付き Number として渡るため、線形メモリが
// 2GiB を超える VM (この wasm は約 2.9GiB) では高位アドレスのポインタが負値に
// なる。この shim (v0.2) は引数をそのまま DataView のオフセットに使うため
// RangeError で WASI 呼び出しが崩壊し、ゲストからはファイルシステムや
// ソケットの散発的なエラーに見える。最外殻で u32 に正規化して防ぐ。
function normalizeU32Args(wasi) {
  for (const name of Object.keys(wasi.wasiImport)) {
    const orig = wasi.wasiImport[name];
    if (typeof orig !== "function") continue;
    wasi.wasiImport[name] = (...a) =>
      orig.apply(wasi.wasiImport,
        a.map((v) => (typeof v === "number" ? v >>> 0 : v)));
  }
}

// 調査用: WASI 呼び出しを記録する (高頻度の read/write/クロック系は除外)
function traceWasiErrors(wasi) {
  const exclude = new Set(["fd_read", "fd_write", "fd_pread", "fd_pwrite",
    "poll_oneoff", "clock_time_get", "random_get", "fd_seek",
    "environ_get", "environ_sizes_get", "args_get", "args_sizes_get",
    "sock_send", "sock_recv"]);
  for (const name of Object.keys(wasi.wasiImport)) {
    if (exclude.has(name)) continue;
    const orig = wasi.wasiImport[name];
    wasi.wasiImport[name] = (...a) => {
      const ret = orig.apply(wasi.wasiImport, a);
      console.log("[trace]", name, "args:", a.slice(0, 4).join(","), "ret:", ret);
      return ret;
    };
  }
}

// container2wasm の worker-util.js (getCertDir) と同じパッチ + 書き込み対応:
// - Bochs の 9p サーバは pread/pwrite でファイルへアクセスするため、
//   seek + read/write で fd_pread / fd_pwrite を補う
// - ディレクトリ自身を指す "." エントリを追加する
function patchDirForC2w(preopenDir) {
  // このバンドル版 (v0.2 系) の Directory 系メソッドはエラー時に -1 を返すが、
  // -1 は有効な WASI errno ではなく、ゲスト側で EINVAL に化けて
  // 「存在チェックの ENOENT」まで失敗扱いになる。ENOENT (44) に読み替える。
  const ERRNO_NOENT = 44;
  for (const m of ["path_filestat_get", "path_unlink_file", "path_remove_directory",
    "path_readlink", "path_rename", "path_create_directory", "path_lookup"]) {
    const orig = preopenDir[m];
    if (typeof orig !== "function") continue;
    preopenDir[m] = (...a) => {
      const r = orig.apply(preopenDir, a);
      if (r === -1) return ERRNO_NOENT;
      if (r && typeof r === "object" && r.ret === -1) r.ret = ERRNO_NOENT;
      return r;
    };
  }

  const _path_open = preopenDir.path_open;
  preopenDir.path_open = (e, r, s, n, a, d) => {
    const existedBefore = preopenDir.dir.get_entry_for_path(r) != null;
    const ret = _path_open.apply(preopenDir, [e, r, s, n, a, d]);
    if (ret.ret === -1) ret.ret = ERRNO_NOENT;
    if (ret.ret === 0 && !existedBefore) {
      // 新規作成: ディレクトリの mtime を進める (readdir/dentry キャッシュの無効化)
      touchEntry(preopenDir.dir);
      touchEntry(ret.fd_obj?.file);
    }
    if (DEBUG_TRACE) console.log("[path_open]", JSON.stringify(r), "oflags:", s, "ret:", ret.ret);
    if (ret.fd_obj != null) {
      const o = ret.fd_obj;
      ret.fd_obj.fd_pread = (view8, iovs, offset) => {
        const oldOffset = o.file_pos;
        if (o.fd_seek(offset, WHENCE_SET).ret != 0) return { ret: -1, nread: 0 };
        const readRet = o.fd_read(view8, iovs);
        if (o.fd_seek(oldOffset, WHENCE_SET).ret != 0) return { ret: -1, nread: 0 };
        return readRet;
      };
      ret.fd_obj.fd_pwrite = (view8, iovs, offset) => {
        const oldOffset = o.file_pos;
        if (o.fd_seek(offset, WHENCE_SET).ret != 0) return { ret: -1, nwritten: 0 };
        const writeRet = o.fd_write(view8, iovs);
        if (o.fd_seek(oldOffset, WHENCE_SET).ret != 0) return { ret: -1, nwritten: 0 };
        touchEntry(o.file);
        return writeRet;
      };
      const _fd_write = o.fd_write.bind(o);
      ret.fd_obj.fd_write = (view8, iovs) => {
        const r = _fd_write(view8, iovs);
        touchEntry(o.file);
        return r;
      };
      // 基底クラスは fd_filestat_set_size / set_times を常に -1 (無効 errno) で
      // 返すため、ゲストの O_TRUNC (v9fs は open 後の Tsetattr size=0 で実現) が
      // EINVAL になる。ftruncate 相当を実装し、時刻設定は成功扱いの nop にする。
      ret.fd_obj.fd_filestat_set_size = (size) => {
        const file = o.file;
        if (!file || !file.data) return 8; // EBADF 相当 (通常ファイル以外)
        const n = Number(size);
        const nd = new Uint8Array(n);
        nd.set(file.data.subarray(0, Math.min(file.data.length, n)));
        file.data = nd;
        touchEntry(file);
        return 0;
      };
      ret.fd_obj.fd_filestat_set_times = () => 0;
      // 基底クラスの fd_close/fd_sync/fd_datasync も -1 を返す未実装スタブで、
      // wasi-libc の truncate() は「ftruncate 成功後の close の戻り値」を
      // そのまま返すため、close の -1 が EINVAL に化けて truncate 全体が失敗する
      ret.fd_obj.fd_close = () => 0;
      ret.fd_obj.fd_sync = () => 0;
      ret.fd_obj.fd_datasync = () => 0;
    }
    return ret;
  };
  // utimensat は path_filestat_set_times になる。メモリ FS では保持しないが
  // 成功として扱う (-1 のままだとゲストで EINVAL に化ける)
  preopenDir.path_filestat_set_times = () => 0;
  // 削除・改名の成功時もディレクトリの mtime を進める
  for (const m of ["path_unlink_file", "path_rename"]) {
    const orig = preopenDir[m].bind(preopenDir);
    preopenDir[m] = (...a) => {
      const r = orig(...a);
      if (r === 0) touchEntry(preopenDir.dir);
      return r;
    };
  }
  preopenDir.dir.contents["."] = preopenDir.dir;
}

function patchWasi(wasi) {
  const ERRNO_INVAL = 28;

  // stdout/stderr を行単位で親へ流す
  const decoder = new TextDecoder();
  let lineBuf = "";
  const emit = (bytes) => {
    lineBuf += decoder.decode(bytes, { stream: true });
    let i;
    while ((i = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, i).replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
      lineBuf = lineBuf.slice(i + 1);
      if (line !== "") postMessage({ type: "log", line });
    }
  };
  const _fd_write = wasi.wasiImport.fd_write;
  wasi.wasiImport.fd_write = (fd, iovs_ptr, iovs_len, nwritten_ptr) => {
    if (fd != 1 && fd != 2) {
      // connfd は後段の wasiHackSocket が処理する
      return _fd_write.apply(wasi.wasiImport, [fd, iovs_ptr, iovs_len, nwritten_ptr]);
    }
    const buffer = new DataView(wasi.inst.exports.memory.buffer);
    const buffer8 = new Uint8Array(wasi.inst.exports.memory.buffer);
    const iovecs = Ciovec.read_bytes_array(buffer, iovs_ptr, iovs_len);
    let wtotal = 0;
    for (const iovec of iovecs) {
      if (iovec.buf_len == 0) continue;
      if (DEBUG_TRACE) {
        console.log("[fd_write]", fd, "iovs_ptr:", iovs_ptr, "buf:", iovec.buf,
          "len:", iovec.buf_len, "mem:", buffer8.length, "head:",
          Array.from(buffer8.slice(iovec.buf, iovec.buf + Math.min(8, iovec.buf_len))).join(","));
      }
      emit(buffer8.slice(iovec.buf, iovec.buf + iovec.buf_len));
      wtotal += iovec.buf_len;
    }
    buffer.setUint32(nwritten_ptr, wtotal, true);
    return 0;
  };

  // poll_oneoff: clock (タイマー) と socket (connfd) の fd_read を扱う。
  // stdin は --no-stdin で無効化しているため fd=0 の poll は実質来ない。
  wasi.wasiImport.poll_oneoff = (in_ptr, out_ptr, nsubscriptions, nevents_ptr) => {
    if (nsubscriptions == 0) return ERRNO_INVAL;
    const buffer = new DataView(wasi.inst.exports.memory.buffer);
    const subs = Subscription.read_bytes_array(buffer, in_ptr, nsubscriptions);
    let clockSub = null;
    let connSub = null;
    let timeout = Number.MAX_VALUE;
    for (const sub of subs) {
      if (sub.u.tag.variant == "clock") {
        if (sub.u.data.timeout < timeout) {
          timeout = sub.u.data.timeout;
          clockSub = sub;
        }
      } else if (sub.u.tag.variant == "fd_read" && sub.u.data.fd == CONN_FD) {
        connSub = sub;
      }
    }
    const events = [];
    if (clockSub || connSub) {
      let sockReadable = false;
      if (connSub) {
        // socket poll は親スレッドのタイマーで待つ (clock 待ちも兼ねる)
        const waitSec = clockSub && timeout !== Number.MAX_VALUE
          ? timeout / 1000000000 : 0.1;
        const r = sockWaitForReadable(waitSec);
        if (r == errStatus) return ERRNO_INVAL;
        sockReadable = (r === true);
      } else if (clockSub && timeout > 0) {
        sleepMs(Math.min(timeout / 1000000, 100)); // ns -> ms
      }
      if (connSub && sockReadable) {
        const event = new Event();
        event.userdata = connSub.userdata;
        event.error = 0;
        event.type = new EventType("fd_read");
        events.push(event);
      }
      if (clockSub) {
        const event = new Event();
        event.userdata = clockSub.userdata;
        event.error = 0;
        event.type = new EventType("clock");
        events.push(event);
      }
    }
    Event.write_bytes_array(buffer, out_ptr, events);
    buffer.setUint32(nevents_ptr, events.length, true);
    return 0;
  };
}

// c2w VM を 1 回実行する。dataDir はゲストの /data になる PreopenDirectory
// (パッチはここで適用する)。実行完了後の結果 (生成物) の取り出しは呼び出し側で
// dataDir.dir.contents から行う。
async function runC2w({
  module,               // WebAssembly.Module
  dataDir,              // PreopenDirectory("/data", {...})
  containerArgs = [],   // コンテナコマンド (エントリポイントへの引数)
  entrypoint = null,    // エントリポイント差し替え
  extraEnv = [],        // 追加の環境変数 (KEY=VALUE)
  stdin = false,        // true なら --no-stdin を付けない
  rawArgs = null,       // 調査用: argv を丸ごと差し替える
  noNodeProxy = false,  // 調査用: ゲスト内 Node のプロキシ env を外す
}) {
  // c2w-net-proxy (ネットワークスタック worker) が生成した TLS 証明書を受け取る。
  // ゲストの /.wasmenv/proxy.crt に見せ、プロキシの MITM 証明書を信頼させる。
  const cert = await recvCert();
  const certDir = getCertDir(cert);

  patchDirForC2w(dataDir);

  // Bochs 側 argv: 既知フラグの後、`--` 以降がコンテナコマンド
  const runtimeFlags = [];
  if (!stdin) runtimeFlags.push("--no-stdin");
  if (entrypoint) runtimeFlags.push(`--entrypoint=${entrypoint}`);
  runtimeFlags.push(`--net=socket=listenfd=${LISTEN_FD}`, "--mac", genmac());
  const args = rawArgs ? ["out.wasm", ...rawArgs]
    : ["out.wasm", ...runtimeFlags, "--", ...containerArgs];
  const env = [
    "SSL_CERT_FILE=/.wasmenv/proxy.crt",
    `https_proxy=${C2W_PROXY_URL}`,
    `http_proxy=${C2W_PROXY_URL}`,
    `HTTPS_PROXY=${C2W_PROXY_URL}`,
    `HTTP_PROXY=${C2W_PROXY_URL}`,
    ...extraEnv,
  ];
  if (!noNodeProxy) {
    // vivliostyle-cli (ゲスト内 Node) は外部リソースを自前の dev server 経由で
    // 取得する。Node の fetch (undici) は既定でプロキシ環境変数を見ないため、
    // Node 24 の NODE_USE_ENV_PROXY で有効化し、プロキシの MITM 証明書は
    // NODE_EXTRA_CA_CERTS で信頼させる。
    env.push(
      "NODE_USE_ENV_PROXY=1",
      "NO_PROXY=localhost,127.0.0.1",
      "NODE_EXTRA_CA_CERTS=/.wasmenv/proxy.crt",
    );
  }
  const fds = [
    undefined, // 0: stdin (--no-stdin なので未使用)
    undefined, // 1: stdout (patchWasi が処理)
    undefined, // 2: stderr (patchWasi が処理)
    dataDir,   // 3: /data (ゲスト init が同じパスへ bind mount する)
    certDir,   // 4: /.wasmenv (プロキシ証明書)
    undefined, // 5: socket listenfd (wasiHackSocket が予約)
    undefined, // 6: accepted socket fd (wasiHackSocket が予約)
  ];
  const wasi = new WASI(args, env, fds);
  patchWasi(wasi);
  wasiHackSocket(wasi, LISTEN_FD, CONN_FD); // sock_* を親スレッド経由の実装に
  patchInode(wasi);
  normalizeU32Args(wasi); // 必ずパッチ群の後 (最外殻) に適用する
  if (DEBUG_TRACE) traceWasiErrors(wasi);

  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  postMessage({ type: "log", line: "[runC2w] starting VM" });
  try {
    wasi.start(instance);
    postMessage({ type: "log", line: "[runC2w] wasi.start returned" });
  } catch (e) {
    // proc_exit を例外で伝える実装があるため、ここでは失敗扱いにしない
    postMessage({ type: "log", line: "[runC2w] wasi.start: " + String(e) });
  }
}
