#!/bin/sh
# デプロイ済みの GitHub Pages から gzip 分割パーツを取得し、リポジトリ直下に
# out.wasm を復元する。ローカルで c2w 変換をやり直さずに、配信されているものと
# 同一の wasm を Node.js デモ (node/run.mjs) やブラウザデモ (?wasm=out.wasm) で
# 使える。
#
# 使い方: ./fetch-wasm.sh [base-url]
set -eu
base="${1:-https://u1f992.github.io/vivliostyle-c2w-demo}"
cd "$(dirname "$0")"
parts=$(curl -fsSL "$base/wasm-manifest.json" \
  | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin)["parts"]))')
for p in $parts; do
  echo "fetching $p" >&2
  curl -fsSL "$base/$p"
done | gunzip > out.wasm
ls -la out.wasm
