#!/bin/sh
# 変換済み wasm を gzip 圧縮し、GitHub にコミット可能な 45MB のパーツ列と
# wasm-manifest.json を生成する。
#
# 使い方: ./make-parts.sh path/to/vivliostyle-root.wasm
set -eu
src="$1"
cd "$(dirname "$0")"
mkdir -p wasm
rm -f wasm/out.wasm.gz.part*
if command -v pigz >/dev/null 2>&1; then
  pigz -9 -c "$src" | split -b 45m -d - wasm/out.wasm.gz.part
else
  gzip -9 -c "$src" | split -b 45m -d - wasm/out.wasm.gz.part
fi
python3 - <<'EOF'
import json, os
parts = sorted(p for p in os.listdir('wasm') if p.startswith('out.wasm.gz.part'))
json.dump({'parts': ['wasm/' + p for p in parts]}, open('wasm-manifest.json', 'w'), indent=2)
EOF
ls -la wasm/
