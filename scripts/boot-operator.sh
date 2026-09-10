#!/usr/bin/env bash
# Headless operator boot (laptop or VPS). No .env. Key Ring + public ids.
#   npm run boot              # stay up
#   npm run boot -- --smoke   # curl /proxy, then exit
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SMOKE=0
[ "${1:-}" = "--smoke" ] && SMOKE=1

if [ -z "${WALLET_PASS:-}" ]; then
  WALLET_PASS="$(node --experimental-strip-types scripts/load-wallet-pass.mjs --print)"
  export WALLET_PASS
fi
if [ -z "${WALLET_PASS:-}" ]; then
  echo "WALLET_PASS missing — npm run device" >&2
  exit 1
fi

if [ -f .live-results/operator-ids.env ]; then
  set -a
  # shellcheck disable=SC1091
  . .live-results/operator-ids.env
  set +a
fi

: "${MANDATE_HEDERA_ACCOUNT_ID:?set MANDATE_HEDERA_ACCOUNT_ID (or .live-results/operator-ids.env)}"
: "${MANDATE_HCS_TOPIC_ID:?set MANDATE_HCS_TOPIC_ID}"

export SERVICE_PORT="${SERVICE_PORT:-8403}"
export MANDATE_PORT="${MANDATE_PORT:-8402}"
export MANDATE_HOST="${MANDATE_HOST:-127.0.0.1}"
export MANDATE_UPSTREAM="${MANDATE_UPSTREAM:-http://127.0.0.1:${SERVICE_PORT}/analytics}"
export MANDATE_STEPUP_DISCOVER_MS="${MANDATE_STEPUP_DISCOVER_MS:-3000}"
export MANDATE_STEPUP_ATTEMPTS="${MANDATE_STEPUP_ATTEMPTS:-1}"

svc_pid=""
gw_pid=""
cleanup() {
  kill "$svc_pid" "$gw_pid" 2>/dev/null || true
}
trap cleanup EXIT

node --experimental-strip-types packages/service/src/index.ts &
svc_pid=$!
for _ in $(seq 1 40); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${SERVICE_PORT}/analytics" || true)
  if [ "$code" = "402" ] || [ "$code" = "200" ]; then break; fi
  sleep 0.25
done
if [ "${code:-}" != "402" ] && [ "${code:-}" != "200" ]; then
  echo "paid service did not come up on :${SERVICE_PORT} (HTTP ${code:-none})" >&2
  exit 1
fi

node --experimental-strip-types packages/gateway/src/index.ts &
gw_pid=$!
for _ in $(seq 1 40); do
  gw=$(curl -sS -o /tmp/mandate-proxy.body -w '%{http_code}' --max-time 8 \
    "http://127.0.0.1:${MANDATE_PORT}/proxy?q=%7B%20a%20%7B%20id%20%7D%20%7D" || true)
  [ -n "$gw" ] && [ "$gw" != "000" ] && break
  sleep 0.25
done

echo "BOOT_OK service=:${SERVICE_PORT} gateway=:${MANDATE_PORT} unpaid=${code} proxy=${gw:-none}"
if [ "$SMOKE" = "1" ]; then
  # Policy maps unregistered merchant / missing device to 403; 503 = missing Hedera key.
  case "$gw" in
    403|503) echo "SMOKE_OK HTTP $gw" ;;
    *)
      echo "SMOKE_FAIL HTTP ${gw:-none} body=$(head -c 200 /tmp/mandate-proxy.body 2>/dev/null)" >&2
      exit 1
      ;;
  esac
  exit 0
fi

echo "Ctrl-C to stop. Bind MANDATE_HOST=0.0.0.0 only behind an authenticated front door."
wait
