#!/usr/bin/env bash
# Headless VPS bootstrap. Copy secrets/*.enc, mandate.yaml, and
# .live-results/operator-ids.env first. Never writes X402_PRIVATE_KEY or a .env.
#
#   bash scripts/vps-bootstrap.sh           # ci + verify, then print boot hint
#   bash scripts/vps-bootstrap.sh --smoke   # then npm run boot -- --smoke
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -z "${WALLET_PASS:-}" ]; then
  echo "Set WALLET_PASS from your password manager (not disk). On a laptop, Keychain via npm run boot is enough." >&2
  # laptop: boot-operator.sh loads Keychain; VPS must export WALLET_PASS.
  if ! WALLET_PASS="$(node --experimental-strip-types scripts/load-wallet-pass.mjs --print 2>/dev/null || true)"; then
    WALLET_PASS=""
  fi
  export WALLET_PASS
fi
if [ -z "${WALLET_PASS:-}" ]; then
  echo "WALLET_PASS missing — cannot unseal the Key Ring." >&2
  exit 1
fi

if [ -f .live-results/operator-ids.env ]; then
  set -a
  # shellcheck disable=SC1091
  . .live-results/operator-ids.env
  set +a
fi

npm ci
npm run verify
echo "VPS_READY — npm run boot   # or: npm run boot -- --smoke"

if [ "${1:-}" = "--smoke" ]; then
  : "${MANDATE_HEDERA_ACCOUNT_ID:?copy .live-results/operator-ids.env}"
  : "${MANDATE_HCS_TOPIC_ID:?copy .live-results/operator-ids.env}"
  exec npm run boot -- --smoke
fi
