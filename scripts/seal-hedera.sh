#!/usr/bin/env bash
# Seal Hedera payment key only (Graph already sealed).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS="$ROOT/secrets"
export WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w 2>/dev/null) || true
[ -z "${WALLET_PASS:-}" ] && { echo "WALLET_PASS missing — npm run device"; exit 1; }
mkdir -p "$SECRETS"
if [ -f "$SECRETS/hedera.enc" ]; then
  echo "hedera-payment already sealed"
  exit 0
fi
echo "Paste Hedera ECDSA private key hex (testnet payer), then Ctrl-D:"
if printf '%s' "$(cat)" | wallet-cli ring encrypt --key hedera-payment > "$SECRETS/hedera.enc"; then
  wallet-cli ring decrypt --key hedera-payment < "$SECRETS/hedera.enc" >/dev/null
  echo "sealed hedera-payment → secrets/hedera.enc"
else
  rm -f "$SECRETS/hedera.enc"
  exit 1
fi
