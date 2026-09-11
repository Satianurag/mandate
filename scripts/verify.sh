#!/usr/bin/env bash
# Deterministic checks only: no wallet, chain, external Graph, or registry requirements.
set -euo pipefail
node scripts/apply-security-patches.mjs
node --test scripts/security-patches.test.mjs
npm run build
npm test
node --experimental-strip-types --test scripts/resolve-pay-to.test.mjs
printf '\nDeterministic verification passed. No live payment or device signature was requested.\n'
