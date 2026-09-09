#!/usr/bin/env bash
# Ledger Key Ring setup + the last unresolved tests.
#
# Fully automatic: it WAITS for the device rather than demanding you run it at
# the right moment. Unlock the Ledger whenever you like and this picks it up.
#
# Your 24-word recovery phrase is never involved. This script never asks for
# it, wallet-cli never asks for it, and nothing in this project ever will.
# If anything ever asks you to type those words into a computer, it is a scam.
set -uo pipefail

SERVICE=ledger-wallet-cli
ACCOUNT=default
RESULTS=".device-results"
WCT="$(cd "$(dirname "$0")/.." && pwd)/scripts/wct.mjs"

ok(){   printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad(){  printf '  \033[31m✗\033[0m %s\n' "$1"; }
info(){ printf '  \033[2m%s\033[0m\n' "$1"; }
hdr(){  printf '\n\033[1m%s\033[0m\n' "$1"; }

probe(){ node "$WCT" 15000 genuine-check 2>&1; }
is_unlocked(){ printf '%s' "$1" | grep -qi genuine && ! printf '%s' "$1" | grep -qi unlock; }
is_absent(){ printf '%s' "$1" | grep -qiE "no ledger|not found|no device|TIMEOUT|unknown error"; }

printf '\n\033[1mLedger Key Ring — setup and final tests\033[0m\n'
: > "$RESULTS"

# ---------------------------------------------------------------- password ---
hdr "1. Key Ring password"
if security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w >/dev/null 2>&1; then
  ok "already in the macOS Keychain"
else
  PW=$(openssl rand -base64 24)
  printf '%s\n%s\n' "$PW" "$PW" | security add-generic-password -a "$ACCOUNT" -s "$SERVICE" -w >/dev/null 2>&1
  unset PW
  if security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w >/dev/null 2>&1; then
    ok "generated a random 24-byte password and stored it in the Keychain"
    info "it never touched argv, the process list, or shell history"
    info "read it back any time:  security find-generic-password -a default -s $SERVICE -w"
  else
    bad "could not write to the Keychain"; exit 1
  fi
fi
export WALLET_PASS=$(security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w)

# ------------------------------------------------------------ wait: unlock ---
hdr "2. Waiting for the device"
info "Unlock the Ledger with your PIN and leave it on the dashboard (the app grid)."
info "If it is brand new, finish setup on the device first — set a PIN and write"
info "the 24 words on the card. Do that part alone; nothing here needs them."
printf '  '
for i in $(seq 1 120); do
  out=$(probe)
  if is_unlocked "$out"; then printf '\n'; ok "device unlocked and on the dashboard"; break; fi
  printf '.'
  [ "$i" = 120 ] && { printf '\n'; bad "gave up after ~20 minutes"; exit 1; }
  node -e "setTimeout(()=>{},10000)"
done

# ------------------------------------------------------------------- init ---
hdr "3. Provisioning the Key Ring"
if wallet-cli ring keys 2>&1 | grep -q '"ok": *true'; then
  ok "already provisioned on this machine"
else
  info "WATCH THE DEVICE — it will ask you to confirm. Approve on the hardware."
  if wallet-cli ring init --name "mandate-$(hostname -s)" 2>&1 | tail -5; then
    ok "ring init complete"; echo "ring_init=ok" >> "$RESULTS"
  else
    bad "ring init failed"; echo "ring_init=fail" >> "$RESULTS"; exit 1
  fi
fi

# --------------------------------------------------------------- FINDING F6 ---
hdr "4. Finding F6 — what does ring decrypt return over a pipe?"
PROBE="mandate-probe-$(date +%s)"
sealed=$(printf '%s' "$PROBE" | wallet-cli ring encrypt --key mandate-probe 2>/dev/null | base64)
if [ -z "$sealed" ]; then bad "ring encrypt produced nothing"; echo "f6=encrypt-failed" >> "$RESULTS"; exit 1; fi
ok "sealed $(printf '%s' "$sealed" | wc -c | tr -d ' ') bytes"

opened=$(printf '%s' "$sealed" | base64 --decode | wallet-cli ring decrypt --key mandate-probe 2>/dev/null)
if [ "$opened" = "$PROBE" ]; then
  ok "RAW PLAINTEXT — keyring.ts needs no unwrapping. F6 resolved."
  echo "f6=raw" >> "$RESULTS"
elif printf '%s' "$opened" | grep -q '"ok"'; then
  bad "JSON ENVELOPE — keyring.ts must unwrap .data"
  info "$(printf '%s' "$opened" | head -c 160)"
  echo "f6=envelope" >> "$RESULTS"
else
  bad "unexpected output"; info "$(printf '%s' "$opened" | head -c 160)"
  echo "f6=unknown" >> "$RESULTS"
fi

# ------------------------------------------------- the load-bearing claim ---
hdr "5. Headless decrypt — the whole Ledger-track thesis"
info "Now UNPLUG the Ledger. No need to press anything; this notices."
printf '  '
unplugged=0
for i in $(seq 1 60); do
  if is_absent "$(probe)"; then printf '\n'; ok "device removed"; unplugged=1; break; fi
  printf '.'
  node -e "setTimeout(()=>{},5000)"
done
[ "$unplugged" = 0 ] && { printf '\n'; bad "device still attached; skipping"; echo "headless=skipped" >> "$RESULTS"; exit 1; }

opened2=$(printf '%s' "$sealed" | base64 --decode | wallet-cli ring decrypt --key mandate-probe 2>/dev/null)
if [ "$opened2" = "$PROBE" ]; then
  ok "DECRYPTED WITH NO DEVICE ATTACHED"
  info "Seal once with the device, open anywhere afterwards. The VPS demo works."
  echo "headless=ok" >> "$RESULTS"
else
  bad "headless decrypt FAILED — the device appears to be required every time"
  info "If so, drop the non-USB deployment claim from the pitch. Better today."
  echo "headless=fail" >> "$RESULTS"
fi

hdr "Results written to $RESULTS"
cat "$RESULTS" | sed 's/^/  /'
printf '\n'
