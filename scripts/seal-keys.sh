#!/usr/bin/env bash
# Seal Graph + Hedera credentials into the Ledger Key Ring.
# Never pass secrets on the command line — use stdin or a prompt.
set -euo pipefail

SERVICE=ledger-wallet-cli
ACCOUNT=default
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS="$ROOT/secrets"

ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; }
info(){ printf '  \033[2m%s\033[0m\n' "$1"; }
hdr(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

hdr "Mandate — seal credentials"
mkdir -p "$SECRETS"

if ! security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w >/dev/null 2>&1; then
  echo "Key Ring password missing. Run: npm run device"
  exit 1
fi
export WALLET_PASS=$(security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w)

if [ -f "$SECRETS/graph.enc" ]; then
  ok "graph-gateway already sealed ($SECRETS/graph.enc)"
else
  info "Paste Graph Studio API key (from https://thegraph.com/studio/apikeys/), then Ctrl-D:"
  if printf '%s' "$(cat)" | wallet-cli ring encrypt --key graph-gateway > "$SECRETS/graph.enc"; then
    if wallet-cli ring decrypt --key graph-gateway < "$SECRETS/graph.enc" >/dev/null 2>&1; then
      ok "sealed graph-gateway → secrets/graph.enc (decrypt verified)"
    else
      rm -f "$SECRETS/graph.enc"
      echo "graph.enc not decryptable — check WALLET_PASS"; exit 1
    fi
  else
    rm -f "$SECRETS/graph.enc"
    echo "graph seal failed"; exit 1
  fi
fi

if [ -f "$SECRETS/hedera.enc" ]; then
  ok "hedera-payment already sealed ($SECRETS/hedera.enc)"
else
  info "Paste Hedera ECDSA private key hex (testnet payer), then Ctrl-D:"
  if printf '%s' "$(cat)" | wallet-cli ring encrypt --key hedera-payment > "$SECRETS/hedera.enc"; then
    if wallet-cli ring decrypt --key hedera-payment < "$SECRETS/hedera.enc" >/dev/null 2>&1; then
      ok "sealed hedera-payment → secrets/hedera.enc (decrypt verified)"
    else
      rm -f "$SECRETS/hedera.enc"
      echo "hedera.enc not decryptable — check WALLET_PASS"; exit 1
    fi
  else
    rm -f "$SECRETS/hedera.enc"
    echo "hedera seal failed"; exit 1
  fi
fi

hdr "Next"
info "export MANDATE_HEDERA_ACCOUNT_ID=0.0.xxxxx   # payer account"
info "export SERVICE_PAY_TO=\$MANDATE_HEDERA_ACCOUNT_ID  # receiver for demo"
info "npm run provision:hcs   # create audit topic (optional, Day 2)"
info "npm run e2e:payment"
