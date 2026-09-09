#!/usr/bin/env bash
# Poll until wallet-cli can talk to the device (handles sleep + PIN unlock).
set -uo pipefail
cd "$(dirname "$0")/.."

if [ -z "${WALLET_PASS:-}" ]; then
  WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w 2>/dev/null || true)
  export WALLET_PASS
fi

export WALLET_DEVICE_MAX_MS="${WALLET_DEVICE_MAX_MS:-180000}"
export LEDGER_DEVICE_TIMEOUT_MS="${LEDGER_DEVICE_TIMEOUT_MS:-120000}"

node scripts/ledger-reset.mjs 2>/dev/null || true

printf '\033[1mWaiting for Ledger\033[0m\n'
printf '  Plug in, unlock dashboard, quit Ledger Wallet desktop.\n'
printf '  If locked, enter PIN — script waits (does not kill early).\n\n'

for i in $(seq 1 180); do
  out=$(node scripts/wallet-device.mjs genuine-check --output json --device-timeout "$LEDGER_DEVICE_TIMEOUT_MS" 2>&1 || true)
  if printf '%s' "$out" | grep -q '"genuine": true\|"genuine":true'; then
    printf '  device ready (attempt %d)\n' "$i"
    exit 0
  fi
  node scripts/ledger-reset.mjs 2>/dev/null || true
  printf '\r  waiting… %ds (unlock PIN if prompted)  ' "$i"
  sleep 2
done

printf '\n\033[31mTimed out — disable auto-lock, unlock dashboard, retry\033[0m\n'
exit 1
