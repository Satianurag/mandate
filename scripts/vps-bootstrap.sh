#!/usr/bin/env bash
# Headless VPS bootstrap. Copy secrets/*.enc + mandate.yaml first.
# Never writes X402_PRIVATE_KEY or a plaintext .env.
set -euo pipefail
if [ -z "${WALLET_PASS:-}" ]; then
  echo "Set WALLET_PASS from your password manager (not disk)." >&2
  exit 1
fi
npm ci
npm run verify
echo "VPS_READY — start facilitator / mandate-service / gateway as on the laptop."
