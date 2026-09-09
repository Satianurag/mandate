#!/usr/bin/env bash
# Retries `ring init` until the Ledger Sync app is installed AND open on the
# device, then runs the two outstanding tests. Fails fast and harmlessly each
# time the app is not ready, so retrying costs nothing.
set -uo pipefail
cd "$(dirname "$0")/.."
RESULTS=".device-results"; : > "$RESULTS"
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad(){ printf '  \033[31m✗\033[0m %s\n' "$1"; }
info(){ printf '  \033[2m%s\033[0m\n' "$1"; }
hdr(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

export WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w 2>/dev/null)
[ -z "$WALLET_PASS" ] && { bad "no Key Ring password in the Keychain"; exit 1; }

printf '\n\033[1mWaiting for the Ledger Sync app\033[0m\n'
info "Install it via the Ledger Wallet app (Settings -> Ledger Sync),"
info "quit that app so it releases USB, then open Ledger Sync on the device."

if wallet-cli ring keys 2>&1 | grep -q '"ok": *true'; then
  ok "Key Ring already provisioned"
else
  provisioned=0
  for i in $(seq 1 90); do
    if pgrep -f "Ledger Wallet.app/Contents/MacOS" >/dev/null 2>&1; then
      printf '\r  \033[33m!\033[0m Ledger Wallet app is open — quit it so wallet-cli can reach the device (attempt %d)   ' "$i"
      node -e "setTimeout(()=>{},15000)"; continue
    fi
    out=$(node scripts/wct.mjs 60000 ring init --name "mandate-$(hostname -s)" 2>&1)
    if printf '%s' "$out" | grep -qiE "error|✖|TIMEOUT"; then
      printf '\r  waiting… attempt %d  \033[2m(%s)\033[0m          ' "$i" "$(printf '%s' "$out" | grep -oiE 'open Ledger Sync app|unknown error|TIMEOUT' | head -1)"
      node -e "setTimeout(()=>{},15000)"
    else
      printf '\n'; ok "ring init complete"; echo "ring_init=ok" >> "$RESULTS"; provisioned=1; break
    fi
  done
  [ "$provisioned" = 0 ] && { printf '\n'; bad "gave up waiting"; echo "ring_init=timeout" >> "$RESULTS"; exit 1; }
fi

hdr "Finding F6 — raw plaintext or JSON envelope?"
PROBE="mandate-probe-$(date +%s)"
sealed=$(printf '%s' "$PROBE" | wallet-cli ring encrypt --key mandate-probe 2>/dev/null | base64)
[ -z "$sealed" ] && { bad "ring encrypt produced nothing"; echo "f6=encrypt-failed" >> "$RESULTS"; exit 1; }
ok "sealed $(printf '%s' "$sealed" | wc -c | tr -d ' ') bytes"
opened=$(printf '%s' "$sealed" | base64 --decode | wallet-cli ring decrypt --key mandate-probe 2>/dev/null)
if [ "$opened" = "$PROBE" ]; then
  ok "RAW PLAINTEXT — keyring.ts needs no unwrapping"; echo "f6=raw" >> "$RESULTS"
elif printf '%s' "$opened" | grep -q '"ok"'; then
  bad "JSON ENVELOPE — keyring.ts must unwrap .data"; echo "f6=envelope" >> "$RESULTS"
else
  bad "unexpected"; info "$(printf '%s' "$opened" | head -c 140)"; echo "f6=unknown" >> "$RESULTS"
fi

hdr "Headless decrypt — the load-bearing claim"
info "Now UNPLUG the Ledger. No keypress needed; this notices."
printf '  '
for i in $(seq 1 60); do
  if node scripts/wct.mjs 12000 genuine-check 2>&1 | grep -qiE "no ledger|not found|no device|TIMEOUT|unknown error"; then
    printf '\n'; ok "device removed"; break
  fi
  printf '.'; node -e "setTimeout(()=>{},5000)"
done
opened2=$(printf '%s' "$sealed" | base64 --decode | wallet-cli ring decrypt --key mandate-probe 2>/dev/null)
if [ "$opened2" = "$PROBE" ]; then
  ok "DECRYPTED WITH NO DEVICE ATTACHED — the VPS demo works"; echo "headless=ok" >> "$RESULTS"
else
  bad "headless decrypt FAILED — drop the non-USB claim from the pitch"; echo "headless=fail" >> "$RESULTS"
fi
hdr "Results"; sed 's/^/  /' "$RESULTS"; printf '\n'
