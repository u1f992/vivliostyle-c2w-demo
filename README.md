# vivliostyle-c2w-demo

テキストボックスのMarkdown（VFM）を、**ブラウザ内で動くx86_64 Linux VM**上の[vivliostyle-cli](https://github.com/vivliostyle/vivliostyle-cli)で組版してPDFをダウンロードするデモ。[container2wasm](https://github.com/container2wasm/container2wasm)で`ghcr.io/u1f992/vivliostyle-slim`コンテナイメージをWASI（WebAssembly）に変換し、BochsによるCPUエミュレーションごとブラウザで実行する。

`<style>`タグ内の`@import`によるWebフォント（Google Fonts）にも対応する。ネットワークはブラウザ内で動くユーザ空間TCP/IPスタック（[c2w-net-proxy](https://github.com/container2wasm/container2wasm/tree/main/extras/c2w-net-proxy)）がHTTP/HTTPSをFetch APIに変換して提供する（CORSを許可するサイトのみ到達可）。

- 初回ロード：圧縮済みwasm約340MBのダウンロードと伸長・コンパイル
- 組版：エミュレーション内でChromeが起動するため数分〜十数分かかる
- 動作確認はChromeのみ

## デプロイ（GitHub Pages）

Actionsタブから"Build and deploy to Pages"を手動実行（workflow_dispatch）する。[.github/workflows/gh-pages.yml](.github/workflows/gh-pages.yml)が次をすべて行うため、ビルド産物をリポジトリにコミットする必要はない。

1. container2wasmのリリース（バイナリと`c2w-net-proxy.wasm`）をSHA256検証付きで取得
2. ラッパーイメージ（[Dockerfile.rootwrap](Dockerfile.rootwrap)）をビルドし、c2wでWASIに変換（エミュレータとLinuxカーネルのビルドを含むため1時間前後かかる）
3. wasmをgzip圧縮して45MBのパーツに分割（[make-parts.sh](make-parts.sh)）
4. 静的ファイルと合わせて`site/`を組み立て、Pagesへデプロイ

wasm（約911MB）を分割配信するのは、GitHubの100MB/ファイル制限と、GitHub ReleasesがCORSヘッダを返さずブラウザから直接取得できないため。実行時に`wasm-manifest.json`に従って順に取得し、`DecompressionStream`で伸長して結合する。

COOP/COEPヘッダはPagesでは付与できないため、cross-origin isolation（SharedArrayBufferに必要）は同梱の[coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker)がクライアント側で有効化する（初回アクセス時に1度自動リロードされる）。

## wasmの生成

素の`ghcr.io/u1f992/vivliostyle-slim:v11.0.4-4`（amd64）をそのまま変換したものでは動かない。[Dockerfile.rootwrap](Dockerfile.rootwrap)が次の問題を吸収する。

1. **9pマウントがroot専用**：container2wasm（Bochsフォーク）の9pサーバはマウントをmode 0000／uid 0でゲストに見せるため、`USER vivliostyle`のままでは作業ディレクトリを読めない → `USER root`
2. **puppeteerのlaunch timeout**：vivliostyle-cliは`puppeteer.launch()`にtimeoutを渡さず既定30秒が固定される。エミュレーション下のChrome起動は30秒に収まらない → `timeout: 0`をsedで注入
3. **Chromeのsandbox・証明書・プロキシbypass**：root実行のため`--no-sandbox`、プロキシのMITM証明書のため`--ignore-certificate-errors`を注入し、localhostの暗黙バイパスを打ち消す`<-loopback>`の強制追加を除去する（これがないとVM内部のビューアサーバへのアクセスまでプロキシへ送られて組版が失敗する）

変換コマンド（workflowが実行するものと同じ）：

```console
$ docker build -t vivliostyle-slim-root -f Dockerfile.rootwrap .
$ c2w --build-arg VM_MEMORY_SIZE_MB=2000 vivliostyle-slim-root "$PWD/out.wasm"
```

`VM_MEMORY_SIZE_MB=2000`はゲストVMのメモリで、上限はcontainer2wasmの変換パイプラインに由来する（wasi-vfs v0.3.0が依存する古いwasmtime 0.34は初期メモリ2GiB超のwasmを扱えず、プリブート後のスナップショットは「ゲストRAM＋約37MB」になるため、実用上限は約2010MB）。

## ローカルでの実行

ビルド産物はリポジトリに含まれないため、まず用意する。

```console
# c2w-net-proxy.wasm（リリースから取得）
$ curl -fsSLO https://github.com/container2wasm/container2wasm/releases/download/v0.8.4/c2w-net-proxy.wasm

# out.wasm（上記「wasmの生成」で変換したもの）を リポジトリ直下に置く
```

配信して`http://localhost:8080/?wasm=out.wasm`を開く（`?wasm=`で非圧縮wasmを直接使える。省略時は`wasm-manifest.json`の分割パーツを探す）。

```console
$ ./serve.sh    # localhost:8080
```

分割パーツ経路（本番と同じロード方法）を試す場合は`./make-parts.sh out.wasm`でパーツを生成し、クエリなしで開く。

なお、デプロイ済みのPagesから配信中のwasmを復元することもできる（ローカルで変換をやり直す必要がない）。

```console
$ ./fetch-wasm.sh    # 分割パーツを取得・伸長してリポジトリ直下にout.wasmを生成
```

## Node.jsでの実行

ブラウザデモと同じwasmと共通コア（`common/`）を、worker_threadsで実行するドライバを`node/run.mjs`に同梱している。**ネットワークスタック（c2w-net-proxy）も同じ構成で動くため、Webフォントも取得できる**。外部転送はNodeのfetchが担うため、ブラウザ版と違ってCORSの制約を受けない。

wasmは`fetch-wasm.sh`（デプロイ済みPagesから復元）またはローカル変換で、`c2w-net-proxy.wasm`はcontainer2wasmのリリースから用意し、いずれもリポジトリ直下に置く。

**Node.js 24以上が必要**（v22ではwasm実行開始直後にV8がSIGSEGVする事象を確認している。同じwasmがNode 24とwasmtimeでは正常に動作するためV8側の問題と判断）。ホストにNode 24がない場合はDockerで実行する。

```console
$ mkdir -p work && cp manuscript.md work/
$ docker run --rm -v "$PWD:/w" node:24 \
    node /w/node/run.mjs --data /w/work -- build manuscript.md -o out.pdf -t 3600
$ ls work/out.pdf
```

- `--data <hostdir>`はホストディレクトリをゲストの`/data`（イメージのWorkingDir）として使う。実行前にメモリ内FSへ読み込み、実行後に書き戻す方式
- 既定でvivliostyle用のプロキシ引数（`--proxy-server`など）をコマンドへ自動追加する。vivliostyle以外を動かす場合は`--raw-command`で無効化し、`--entrypoint <cmd>`でエントリポイントを差し替える（例：`--raw-command --entrypoint /bin/sh -- -c 'ls /'`）
- そのほかのオプションは`node node/run.mjs --help`を参照

## 自動テスト

vivliostyle-slimイメージに同梱のChromeとpuppeteer-coreを使い、ページを実際に開いてビルドまで検証する。成功すると`test/browser.pdf`が保存される。

```console
$ docker run --rm -v "$PWD:/w" --entrypoint node vivliostyle-slim-root \
    /w/test/run-test.mjs
```

環境変数`HTDOCS`で配信ルート（既定`/w`）、`OUT_PDF`で出力先、`RAW_ARGS`（JSON配列）でwasmのargv差し替え（ゲスト内シェルでの調査用）を指定できる。

## 構成

| パス | 内容 |
|---|---|
| `.github/workflows/gh-pages.yml` | 変換〜サイト組み立て〜デプロイのworkflow |
| `Dockerfile.rootwrap` | 変換対象のラッパーイメージ |
| `make-parts.sh` | wasmをgzip圧縮して45MBパーツと`wasm-manifest.json`を生成 |
| `common/vm-runner.js` | **共通コア**：VM実行（`runC2w`）とWASI shimへの7種のパッチ |
| `common/net-stack.js` | **共通コア**：c2w-net-proxy（ネットワークスタック）の実行 |
| `common/stack.js`／`common/worker-util.js`／`common/wasi-util.js` | worker間結線・socket転送・poll定義（container2wasm examples由来、修正あり） |
| `index.html`／`main.js` | ブラウザUI（textarea＋Buildボタン）。PDF完成時に自動ダウンロード |
| `demo-worker.js`／`stack-worker.js` | ブラウザ用エントリ（Web Worker） |
| `node/run.mjs` | Node.js用ドライバ（worker_threadsで共通コアを実行、ネットワーク対応） |
| `node/vm-worker.mjs`／`node/stack-worker.mjs`／`node/bootstrap.mjs` | Node.js用エントリと配線 |
| `browser_wasi_shim/` | WASI実装（[bjorn3/browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim)のUMDバンドル、container2wasm examples由来） |
| `coi-serviceworker.js` | cross-origin isolationの付与 |
| `fetch-wasm.sh` | デプロイ済みPagesから分割パーツを取得してout.wasmを復元 |
| `test/run-test.mjs` | ブラウザE2Eテスト |

## 技術的な詳細

WASI shim（browser_wasi_shim v0.2バンドル）には、書き込み可能ディレクトリを9pでゲストLinuxにマウントするために7種類のパッチを当てている（`demo-worker.js`）。

1. **i32ポインタ引数のu32正規化**（最重要）：wasm32のi32引数はJSには符号付きNumberとして渡るため、線形メモリが2GiBを超えるこのVM（約2.9GiB）では高位アドレスに確保されたバッファのポインタが負値になる。shimはそれをそのままDataViewのオフセットに使うためRangeErrorでWASI呼び出しが崩壊し、ゲストからはファイルシステムの散発的なENOENT/EIOに見える（バッファの配置に依存するため、修正前は4〜6割の確率で組版が失敗していた）
2. エラー時に返る-1（無効なWASI errno）をENOENTに補正
3. 全ファイルino=0による9p qid衝突をユニークinoの割り当てで解消。readdirのdirentが返すd_ino=1固定も同様に補正（Bochsはこれをそのまま9pのqid.pathに流すため、lookup経由のqidと矛盾してdentryが壊れる）
4. nlink=0（Linuxには削除済みinodeに見える）を1に補正、mtime=0固定（属性キャッシュの再検証をすり抜ける）を書き込みのたびに更新
5. 未実装スタブ（`fd_filestat_set_size`／`fd_close`／`fd_sync`など）の実装。wasi-libcの`truncate()`は「ftruncate成功後のcloseの戻り値」を返すため、closeの-1だけでO_TRUNCを使う上書き保存が全滅する
6. Bochsの9pサーバが使うpread/pwriteの補完と`"."`エントリの追加
7. `path_filestat_set_times`などの時刻設定を成功扱いのnopに

ネットワーク経路の詳細（Node 24の`NODE_USE_ENV_PROXY`によるゲスト内Nodeのプロキシ対応、CORS-safelistedヘッダのフィルタリングなど）はソースコメントを参照。特にレスポンスヘッダの転送では、fetchがボディを自動伸長して平文で返すため、`content-encoding`／`content-length`／`transfer-encoding`を除去する必要がある（転送するとゲストが「gzipと宣言された平文」の伸長を試みてZ_DATA_ERRORになり、Webフォントの取得が失敗する）。

worker_threads上で動かす際の注意として、workerはAtomics.waitで頻繁にブロックするためstdoutパイプ経由のconsole出力が壊れる（フラッシュされない）。Node側エントリはconsoleをpostMessageに委譲して親スレッドで出力する（`node/bootstrap.mjs`）。

## クレジット

このデモは次のソフトウェアを利用・同梱している。

- [container2wasm](https://github.com/container2wasm/container2wasm)（Apache-2.0）：変換ツール本体、c2w-net-proxy、ネットワーク結線スクリプト群の由来。変換されたwasmにはBochs（LGPL-2.1）、Linux（GPL-2.0）、runc（Apache-2.0）などが含まれる
- [bjorn3/browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim)（MIT／Apache-2.0）
- [gzuidhof/coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker)（MIT）
- [vivliostyle-cli](https://github.com/vivliostyle/vivliostyle-cli)（AGPL-3.0）：wasm内のコンテナイメージ（[u1f992/vivliostyle-slim](https://github.com/u1f992/vivliostyle-slim)）に含まれる
