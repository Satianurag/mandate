#!/usr/bin/env bash
# Poll until DmkEvmSigner can resolve the payer (Ethereum app open).
# Unlike wait:ledger, this does NOT require the dashboard genuine-check.
set -uo pipefail
cd "$(dirname "$0")/.."

if [ -z "${WALLET_PASS:-}" ]; then
  WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w 2>/dev/null || true)
  export WALLET_PASS
fi

export MANDATE_ETH_APP_OPEN="${MANDATE_ETH_APP_OPEN:-1}"
export MANDATE_DEVICE_PROBE_MS="${MANDATE_DEVICE_PROBE_MS:-12000}"

node scripts/ledger-reset.mjs 2>/dev/null || true

printf '\033[1mWaiting for Ethereum app\033[0m\n'
printf '  Quit Ledger Wallet desktop. Unlock the device. Open Ethereum. Keep it open.\n\n'

for i in $(seq 1 60); do
  if node --experimental-strip-types scripts/check-mandate.mjs >/tmp/mandate-wait-eth.out 2>/tmp/mandate-wait-eth.err; then
    printf '  ETH_APP_READY (attempt %d)\n' "$i"
    cat /tmp/mandate-wait-eth.out
    exit 0
  fi
  node scripts/ledger-reset.mjs 2>/dev/null || true
  err=$(tail -c 180 /tmp/mandate-wait-eth.err 2>/dev/null | tr '\n' ' ')
  printf '\r  waiting… %ds  %s' "$i" "${err:0:80}"
  sleep 3
done

printf '\n\033[31mTimed out — open Ethereum app, quit Ledger Wallet desktop, retry\033[0m\n'
exit 1
