#!/bin/sh
# ローカル配信。COOP/COEP ヘッダは coi-serviceworker がクライアント側で
# 付与するため、プレーンな静的サーバでよい (GitHub Pages と同条件)。
cd "$(dirname "$0")" || exit 1
exec python3 -m http.server "${PORT:-8080}"
