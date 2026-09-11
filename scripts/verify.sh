#!/usr/bin/env bash
# Deterministic checks only: no wallet, chain, external Graph, or registry requirements.
set -euo pipefail
node scripts/apply-security-patches.mjs
node --test scripts/security-patches.test.mjs
npm run build
npm test
node --experimental-strip-types --test scripts/resolve-pay-to.test.mjs
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1 && [ -d docs ]; then
  node scripts/check-release.mjs
else
  printf '%s\n' 'Release consistency check skipped in the stripped runtime-verification image.'
fi
printf '\nDeterministic verification passed. No live payment or device signature was requested.\n'
