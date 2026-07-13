#!/bin/bash
# ネットワーク断耐性テスト。site/ を HTTP/2 で配信するサーバコンテナと、
# ページを開いて wasm をロードするプローブコンテナを立て、ダウンロード進行中に
# プローブの netns へアドレス変化 (RTM_NEWADDR/RTM_DELADDR) を注入する。
#
# Chrome は OS のネットワーク変化を検知すると全接続を ERR_NETWORK_CHANGED で
# 破棄する。wasm のダウンロードは数分続くため、その間の VPN 切替・docker 起動・
# DHCP 更新・IPv6 一時アドレスのローテーション等がこれに該当する。このテストは
# その状況を決定的に再現する。切断は HTTP/2 セッションを閉じるが HTTP/1.1 の
# 転送は生き残るため、実 Pages と同じ h2 で配信して検証する。
#
# 期待結果: 「接続が中断されました。再開します…」を挟みつつ
# DOWNLOAD_OUTCOME: COMPLETED / RELOAD_OUTCOME: alive で終わること。
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
SUFFIX=$$
SRV=blip-srv-$SUFFIX
PROBE=blip-probe-$SUFFIX
INJECT_COUNT=${INJECT_COUNT:-3}
THROTTLE_BPS=${THROTTLE_BPS:-8000000}

cleanup() { docker rm -f "$SRV" "$PROBE" >/dev/null 2>&1; }
trap cleanup EXIT

if [ ! -f "$REPO/test/tls/cert.pem" ]; then
  mkdir -p "$REPO/test/tls"
  openssl req -x509 -newkey rsa:2048 -keyout "$REPO/test/tls/key.pem" \
    -out "$REPO/test/tls/cert.pem" -days 2 -nodes -subj "/CN=blip-test" 2>/dev/null
fi

docker run -d --name "$SRV" -v "$REPO:/w" -e THROTTLE_BPS="$THROTTLE_BPS" \
  --entrypoint node vivliostyle-slim-root /w/test/serve-h2.mjs >/dev/null
SRV_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$SRV")
echo "server: https://$SRV_IP:8443"

docker run -d --name "$PROBE" -v "$REPO:/w" \
  -e TARGET_URL="https://$SRV_IP:8443/vivliostyle-c2w-demo/" \
  --entrypoint node vivliostyle-slim-root /w/test/blip-inner.mjs >/dev/null

for i in $(seq 1 240); do
  if docker logs "$PROBE" 2>&1 | grep -q "ロード中：[0-9]* MiB"; then break; fi
  if ! docker ps -q -f name="$PROBE" | grep -q .; then
    echo "probe exited early"; docker logs "$PROBE" 2>&1 | tail -20; exit 1
  fi
  sleep 1
done

for n in $(seq 1 "$INJECT_COUNT"); do
  MIB=$(docker logs "$PROBE" 2>&1 | grep -o "ロード中：[0-9]* MiB" | tail -1)
  echo "inject #$n (at $MIB)"
  docker run --rm --net "container:$PROBE" --cap-add NET_ADMIN alpine sh -c \
    "ip link add dummy0 type dummy && ip addr add 10.99.99.$n/32 dev dummy0 && ip link set dummy0 up && sleep 1 && ip addr del 10.99.99.$n/32 dev dummy0 && ip link del dummy0" \
    || echo "injection #$n failed"
  sleep 8
done

for i in $(seq 1 600); do
  docker ps -q -f name="$PROBE" | grep -q . || break
  sleep 1
done
echo "===== result ====="
docker logs "$PROBE" 2>&1 | grep -E "isolated|\[status\]|page!|SW:|OUTCOME"
docker logs "$PROBE" 2>&1 | grep -q "DOWNLOAD_OUTCOME: COMPLETED" \
  && docker logs "$PROBE" 2>&1 | grep -q "RELOAD_OUTCOME: alive" \
  && echo "PASS" || { echo "FAIL"; exit 1; }
