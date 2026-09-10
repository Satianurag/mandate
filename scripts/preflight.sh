#!/usr/bin/env bash
# Mandate preflight — verifies every live dependency before you write code.
# Every check here corresponds to a finding in docs/FINDINGS.md.
set -uo pipefail

pass=0; fail=0; warn=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
wrn()  { printf '  \033[33m!\033[0m %s\n' "$1"; warn=$((warn+1)); }
note() { printf '    \033[2m%s\033[0m\n' "$1"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

printf '\n\033[1mMandate preflight\033[0m — %s\n' "$(date -u '+%Y-%m-%d %H:%M UTC')"

hdr "Toolchain"
node --version >/dev/null 2>&1 && ok "node $(node --version)" || bad "node not found (need >=20)"
if command -v wallet-cli >/dev/null 2>&1; then
  ok "wallet-cli $(wallet-cli --version 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["version"])' 2>/dev/null || echo '?')"
else
  bad "wallet-cli missing"; note "npm i -g @ledgerhq/wallet-cli"
fi

hdr "Ledger Key Ring  (Ledger track requirement)"
if [ -z "${WALLET_PASS:-}" ]; then
  wrn "WALLET_PASS unset — cannot test headless decrypt"
  note "macOS: export WALLET_PASS=\$(security find-generic-password -a default -s ledger-wallet-cli -w)"
  note "Never write the password literally into a command."
else
  ok "WALLET_PASS set"
fi
ring_provisioned=0
if ! command -v wallet-cli >/dev/null 2>&1; then
  ring_out=""
elif ring_out=$(wallet-cli ring keys 2>&1); then
  if printf '%s' "$ring_out" | grep -q '"ok": *true'; then
    ring_provisioned=1
  elif printf '%s' "$ring_out" | grep -qE '^Key|^─|mandate-|graph-'; then
    # Human table when stdout is a TTY; JSON envelope when piped (F6).
    ring_provisioned=1
  elif ! printf '%s' "$ring_out" | grep -qi 'not initialized'; then
    ring_provisioned=1
  fi
fi
if [ "$ring_provisioned" -eq 1 ]; then
  ok "ring provisioned"
  probe="preflight-$(date +%s)"
  sealed=$(printf '%s' "$probe" | wallet-cli ring encrypt --key mandate-probe 2>/dev/null | base64)
  if [ -n "$sealed" ]; then
    opened=$(printf '%s' "$sealed" | base64 --decode | wallet-cli ring decrypt --key mandate-probe 2>/dev/null)
    if [ "$opened" = "$probe" ]; then
      ok "headless seal/unseal round trip — raw plaintext (F6 resolved)"
    elif printf '%s' "$opened" | grep -q '"ok"'; then
      bad "ring decrypt returned a JSON ENVELOPE, not raw plaintext (finding F6)"
      note "keyring.ts must unwrap .data — update the adapter before Day 2"
    else
      bad "round trip mismatch"
    fi
  else
    bad "ring encrypt produced nothing"
  fi
else
  wrn "ring not provisioned — run 'wallet-cli ring init' with the device attached"
fi

hdr "x402 facilitators"
check_kind() { # name url kind
  body=$(curl -sS --max-time 15 "$2/supported" 2>/dev/null)
  if printf '%s' "$body" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ks={f\"{k.get('scheme')}@{k.get('network')}\" for k in d.get('kinds',[])}
sys.exit(0 if '$3' in ks else 1)" 2>/dev/null; then
    fp=$(printf '%s' "$body" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(next((k.get('extra',{}).get('feePayer','') for k in d.get('kinds',[])
      if f\"{k.get('scheme')}@{k.get('network')}\"=='$3'), ''))" 2>/dev/null)
    ok "$1: $3${fp:+  feePayer $fp}"
  else
    bad "$1 no longer advertises $3"
  fi
}
check_kind "blocky402" "https://api.testnet.blocky402.com" "exact@hedera:testnet"
check_kind "x402.org " "https://x402.org/facilitator" "batch-settlement@eip155:84532"
check_kind "x402.org " "https://x402.org/facilitator" "upto@eip155:84532"

hdr "Chains (testnet)"
cid=$(curl -sS --max-time 15 -X POST https://testnet.hashio.io/api -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' 2>/dev/null | python3 -c 'import sys,json; print(int(json.load(sys.stdin)["result"],16))' 2>/dev/null)
[ "$cid" = "296" ] && ok "Hedera testnet relay — chainId 296" || bad "Hedera relay unreachable (got '${cid:-nothing}')"
cid=$(curl -sS --max-time 15 -X POST https://sepolia.base.org -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' 2>/dev/null | python3 -c 'import sys,json; print(int(json.load(sys.stdin)["result"],16))' 2>/dev/null)
[ "$cid" = "84532" ] && ok "Base Sepolia — chainId 84532" || bad "Base Sepolia unreachable (got '${cid:-nothing}')"

hdr "The Graph"
SUB=43s9hQRurMGjuYnC1r2ZwS6xSQktbFyXMPMqGKUFJojb
code=$(curl -sS -o /dev/null -D /tmp/mf_h.txt -w '%{http_code}' --max-time 25 -X POST \
  "https://gateway.thegraph.com/api/x402/subgraphs/id/$SUB" -H 'content-type: application/json' \
  -d '{"query":"{_meta{block{number}}}"}' 2>/dev/null)
if [ "$code" = "402" ] && grep -qi '^payment-required:' /tmp/mf_h.txt; then
  ok "x402 gateway returns 402 with payment-required header"
  sch=$(grep -i '^payment-required:' /tmp/mf_h.txt | awk '{print $2}' | tr -d '\r' | base64 --decode 2>/dev/null | python3 -c "
import sys,json; a=json.load(sys.stdin)['accepts'][0]; print(a['scheme'],a['network'],int(a['amount'])/1e6,'USDC')" 2>/dev/null)
  note "offers: $sch  (exact only — no batch-settlement, finding F1)"
else
  bad "Graph x402 gateway did not return the expected 402 (HTTP $code)"
fi
SUB_TN=4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u
tn_hdr=$(mktemp)
tn_code=$(curl -sS -o /dev/null -D "$tn_hdr" -w '%{http_code}' --max-time 25 -X POST \
  "https://gateway.testnet.thegraph.com/api/x402/subgraphs/id/$SUB_TN" \
  -H 'content-type: application/json' \
  -d '{"query":"{_meta{block{number}}}"}' 2>/dev/null)
tn_net=$(grep -i '^payment-required:' "$tn_hdr" | awk '{print $2}' | tr -d '\r' | base64 --decode 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['accepts'][0]['network'])" 2>/dev/null || true)
rm -f "$tn_hdr"
if [ "$tn_code" = "402" ] && [ "$tn_net" = "eip155:84532" ]; then
  ok "Graph TESTNET x402 gateway (gateway.testnet.thegraph.com) 402 on Base Sepolia"
else
  bad "Graph testnet x402 unexpected (HTTP ${tn_code:-?} network '${tn_net:-?}'; documented host is NXDOMAIN)"
fi
if [ -f secrets/hedera.enc ] && [ -n "${WALLET_PASS:-}" ]; then
  ok "secrets/hedera.enc present"
elif [ -n "${MANDATE_HEDERA_ACCOUNT_ID:-}" ]; then
  wrn "MANDATE_HEDERA_ACCOUNT_ID set but secrets/hedera.enc missing — npm run seal:keys"
fi

# The sealed key is the only credential path: it is unsealed in-process and
# never touches argv, env, or disk. There is no plaintext-key branch.
if [ -f secrets/graph.enc ] && [ -n "${WALLET_PASS:-}" ]; then
  if node --experimental-strip-types scripts/probe-graph.mjs 2>/dev/null; then
    ok "Agent0 subgraph reachable with sealed key (F7)"
  else
    wrn "sealed Graph key failed — re-check key or WALLET_PASS (finding F7)"
  fi
else
  wrn "secrets/graph.enc or WALLET_PASS missing — Agent0 lookups need it (finding F7)"
  note "Get a key at https://thegraph.com/studio/apikeys/ then: npm run seal:keys"
fi

hdr "Result"
printf '  passed %d   warnings %d   failed %d\n\n' "$pass" "$warn" "$fail"
[ "$fail" -eq 0 ]
