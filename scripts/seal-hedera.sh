#!/usr/bin/env bash
# Seal Hedera keys: payer (hedera-payment) + treasury top-up key (treasury).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS="$ROOT/secrets"
export WALLET_PASS=$(node scripts/load-wallet-pass.mjs --print 2>/dev/null) || true
[ -z "${WALLET_PASS:-}" ] && { echo "WALLET_PASS missing — npm run device"; exit 1; }
mkdir -p "$SECRETS"
seal_one() {
  local keyname="$1" file="$2" prompt="$3"
  if [ -f "$SECRETS/$file" ]; then
    echo "$keyname already sealed"
    return 0
  fi
  echo "$prompt, then Ctrl-D:"
  if printf '%s' "$(cat)" | wallet-cli ring encrypt --key "$keyname" > "$SECRETS/$file"; then
    wallet-cli ring decrypt --key "$keyname" < "$SECRETS/$file" >/dev/null
    echo "sealed $keyname → secrets/$file"
  else
    rm -f "$SECRETS/$file"
    exit 1
  fi
}
seal_one hedera-payment hedera.enc "Paste Hedera ECDSA private key hex (testnet payer)"
seal_one treasury treasury.enc "Paste Hedera ECDSA private key hex (treasury, funds top-ups)"
