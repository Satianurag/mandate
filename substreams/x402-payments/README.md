# x402-payments (Base Sepolia)

Official `substreams` module. Params are live-discovered contract addresses
(USDC, batch-settlement, Permit2) — not baked into the wasm.

```bash
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
substreams build
# Pinax Base Sepolia (F24): needs a sealed API key
npm run e2e:substreams
```

E2E looks for deposit `0x60c8b5d6…` (or `SUBSTREAMS_TX`). Without `PINAX_API_KEY`
or `secrets/pinax.enc`, the run records FINDING F24 (`Unauthenticated`) and
exits 2 — it does not stub hits.
