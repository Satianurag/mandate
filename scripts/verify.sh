#!/usr/bin/env bash
# Full consistency + correctness verification.
set -uo pipefail
pass=0; fail=0
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad(){ printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
hdr(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

printf '\n\033[1mMandate — full verification\033[0m  %s\n' "$(date -u '+%Y-%m-%d %H:%M UTC')"

hdr "1. Tests (every workspace, hermetic)"
for ws in packages/*; do
  if [ -f "$ws/package.json" ] && grep -q '"test"' "$ws/package.json"; then
    name=$(node -e "console.log(require('./$ws/package.json').name)")
    out=$(env -i PATH="$PATH" HOME="$HOME" npm test -w "$name" 2>&1)
    if printf '%s' "$out" | grep -qE "^# fail 0$"; then
      n=$(printf '%s' "$out" | grep -E "^# pass" | awk '{print $3}')
      ok "$name: $n passing"
    else bad "$name tests failing"; fi
  fi
done

hdr "2. Every module parses and imports"
for f in packages/*/src/*.ts; do
  case "$f" in *test*) continue;; esac
  if node --experimental-strip-types -e "import('./$f').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})" >/dev/null 2>&1; then
    ok "$f"
  else bad "$f failed to import"; fi
done

hdr "3. No secrets committed"
tracked=$(git ls-files --error-unmatch .env secrets/*.enc 2>/dev/null || true)
if [ -n "$tracked" ]; then
  bad "secret material tracked in git"
  printf '    \033[2m%s\033[0m\n' "$tracked"
elif [ -f .env ]; then
  bad ".env present locally (gitignored — ok for dev, not for commits)"
else
  ok "no tracked .env or secrets/*.enc (local Key Ring blobs are gitignored)"
fi
if git grep -I -nE "(BEGIN [A-Z ]*PRIVATE|0x[a-fA-F0-9]{64})" \
  -- ':!scripts/verify.sh' ':!mandate.example.yaml' ':!mandate.yaml' >/dev/null 2>&1; then
  bad "possible key material in source"
  git grep -I -nE "(BEGIN [A-Z ]*PRIVATE|0x[a-fA-F0-9]{64})" \
    -- ':!scripts/verify.sh' ':!mandate.example.yaml' ':!mandate.yaml' | head -20
else
  ok "no key-shaped literals in tracked source"
fi

hdr "4. Doc consistency (no contradictions)"
# A doc may quote a claim in order to correct it; only flag it when the line is
# not adjacent to a correction marker.
check_absent(){
  hits=$(grep -rIn --exclude-dir=.git --exclude-dir=node_modules -e "$1" docs README.md 2>/dev/null \
         | grep -viE "correct|stretch|not a load-bearing|honestly labelled|revision 2 (said|called)" || true)
  if [ -n "$hits" ]; then bad "stale claim present: $2"; printf '    \033[2m%s\033[0m\n' "$(printf '%s' "$hits" | head -1 | cut -c1-100)"
  else ok "$2"; fi
}
check_absent "batch settlement against their gateway" "no claim that Graph's gateway takes batch-settlement"
check_absent "first batch-settlement payment channel on Hedera" "no unqualified 'first on Hedera' claim"
grep -q "eip155:84532" docs/architecture.md && ok "architecture names Base Sepolia as the envelope rail" || bad "architecture missing envelope rail"
grep -q "0.0.7162784" docs/architecture.md docs/FINDINGS.md >/dev/null 2>&1 || true
if grep -rq "Never hardcode a fee payer" docs/architecture.md && grep -q "read it from the live challenge" packages/gateway/src/facilitators.ts; then
  ok "fee-payer invariant stated in docs AND enforced in code"; else bad "fee-payer invariant not consistent"; fi
if grep -q "returns HTTP 200" packages/gateway/src/graph.ts && grep -q "HTTP 200 with an error body" docs/architecture.md; then
  ok "Graph 200-on-error invariant in docs AND code"; else bad "Graph 200-on-error inconsistent"; fi
if grep -rq "@mandate/gateway" package.json && ! grep -rq "@breaker" package.json packages/*/package.json; then
  ok "package names match the product name"; else bad "package naming inconsistent"; fi
# one findings log, not two -- two copies of the same finding is how docs drift
if [ -f docs/FINDINGS.md ] && [ ! -f docs/verification.md ]; then
  n=$(grep -cE "^\| F[0-9]+ \|" docs/FINDINGS.md)
  s=$(grep -cE "^## F[0-9]+ " docs/FINDINGS.md)
  if [ "$n" = "$s" ]; then ok "findings log: $n entries, summary table and sections agree"
  else bad "findings log: $n rows in the table but $s sections"; fi
else bad "findings log missing, or a duplicate verification.md is back"; fi

hdr "5. Pinned versions match npm"
while read -r pkg want; do
  got=$(npm view "$pkg" version 2>/dev/null)
  if [ "$got" = "$want" ]; then ok "$pkg@$want"; else bad "$pkg pinned ^$want but npm has $got"; fi
done <<PKGS
@ledgerhq/wallet-cli 2.1.0
@ledgerhq/device-management-kit 1.9.0
@hiero-ledger/sdk 2.88.0
@x402/core 2.25.0
hedera-harness 1.2.2
PKGS

hdr "6. Live rails"
# Probes exit 2 when the host itself is unreachable (sandboxed/egress-filtered
# network) so a red line names its cause instead of crying rail regression.
netcode="const c=e?.cause?.code??e?.code??'';process.exit(['ECONNRESET','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','ECONNREFUSED'].includes(c)?2:1)"
node --experimental-strip-types -e "
import('./packages/gateway/src/facilitators.ts').then(async m=>{
  await m.assertSupports(m.BLOCKY402_URL,'exact@hedera:testnet');
  process.exit(0);
}).catch(e=>{console.error(e.message);eval(\"$netcode\")})" >/dev/null 2>&1
case $? in
  0) ok "exact@hedera:testnet live on Blocky402 (EVM leg is self-hosted; proven by mandate:open)" ;;
  2) bad "Blocky402 UNREACHABLE from this network (re-run verify on the operator host)" ;;
  *) bad "Blocky402 no longer advertises exact@hedera:testnet" ;;
esac
node --experimental-strip-types -e "
import('./packages/gateway/src/graph.ts').then(async m=>{
  const r=await m.queryOrChallenge('43s9hQRurMGjuYnC1r2ZwS6xSQktbFyXMPMqGKUFJojb','{_meta{block{number}}}');
  process.exit(r.kind==='challenge'?0:1);
}).catch(e=>{eval(\"$netcode\")})" >/dev/null 2>&1
case $? in
  0) ok "Graph x402 gateway still returns a decodable 402" ;;
  2) bad "Graph gateway UNREACHABLE from this network (re-run verify on the operator host)" ;;
  *) bad "Graph x402 challenge changed shape" ;;
esac

hdr "Result"
printf '  \033[1mpassed %d   failed %d\033[0m\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
