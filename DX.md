# Ledger integration and developer-experience report

Mandate funds a software spending wallet from a physical Ledger using Device
Management Kit and the Ethereum signer kit. The broker never shows a secret to
the model. Clear-signing uses either a partner `LEDGER_ORIGIN_TOKEN` or the
loopback CAL that matches the **ledger-dev Ethereum app** already loaded on
this device (`CAL_TEST_KEY=1`, app version `1.23.0-dev`).

That development app lives in `/Users/Apple/Documents/ledger-dev/app-ethereum`
and is loaded with `load-ethereum-cal-test.sh`. Production CAL/ERC-7730 on the
stock Ethereum app still needs a Ledger partner origin token.

## Integration actually used

The operator host ran wallet-cli 2.1.0, Device Management Kit 1.9.0, Ethereum Signer
Kit 1.18.0, Context Module 2.5.0, x402 2.25.0, viem 2.56.3 and Hiero SDK 2.88.0.

Key Ring seals the delegated spending key. The trusted broker invokes
`wallet-cli ring decrypt` over pipes, uses the material for one operation, and
wipes the original Buffer afterwards.

DMK resolves the configured Ledger address, requests the EIP-712 funding
authorization, and verifies the returned signature against that principal.
Tool payments then use the sealed software wallet. Ledger is required again
only for allowance increases.

Workspace configuration is in `state/mainnet/operator/setup-draft.json`. The
legacy `mandate.yaml` timed-withdrawal gateway was removed; the current product
is the exact-agent workspace on port 8410.

`npm start` also launches the self-hosted facilitator on `http://127.0.0.1:8406`
when `secrets/mandate-facilitator.enc` and `secrets/mandate-authorizer.enc`
exist. Settings default to that URL; use an external facilitator if secrets are
absent.

## Findings that help an integrator

### 1. Device presence is not approval of an action

Address confirmation is separate from the funding signature. Funding binds
amount, asset, chain, recipient and expiry in the EIP-3009 typed data.

### 2. Report the actual clear-signing path

Without `LEDGER_ORIGIN_TOKEN`, production CAL returns 403 and the stock
Ethereum app falls back to legacy or clear-basic. Mandate fail-closes
unless a partner token is present **or** `MANDATE_LEDGER_TEST_CAL_URL` points
at the loopback bridge used with the ledger-dev app:

```sh
MANDATE_LEDGER_CAL_TEST_KEY_FILE=/Users/Apple/Documents/ledger-dev/app-ethereum/client/src/ledger_app_clients/ethereum/keychain/cal.pem \
  npm run ledger:test-cal
MANDATE_LEDGER_TEST_CAL_URL=http://127.0.0.1:8427 npm start
```

Open the **ledger-dev Ethereum app** on the device before funding. The signing
report records `originToken`, `testCal`, `calFilters` and `verdict`.

**DX gap:** There is no single “am I ready to fund?” screen that shows CAL health,
device app name, and origin-token status together. Integrators must read console
stderr and run `scripts/dev/probe-ledger-preflight.mjs` separately.

### 3. Be precise about headless behavior

Key Ring decrypt after `ring init` does not need USB. Funding and allowance
increases still need the device. Tool payments after funding do not.

**DX gap:** The distinction between “address read succeeded” and “funding
signature succeeded” is easy to misread in the UI status line. A clearer
two-step checklist (address confirmed → allowance signed) would help demos.

### 4. ERC-7730 descriptor alignment

Mandate adds an explicit `EIP712Domain` type before DMK calls so descriptor
lookup matches the device (`withExplicitEip712DomainType` in `dmksigner.ts`).
Without this, CAL can succeed in tests but the digest path differs from naive
x402 payloads.

**Tutorial idea:** “Wire DMK funding for x402 exact USDC on Base” with a
minimal EIP-3009 `ReceiveWithAuthorization` example and the descriptor JSON
under `docs/erc7730/`.

### 5. Operator workspace vs old mandate.yaml model

Judges cloning the repo should use `npm start` only. Retired HTTP routes
(`/api/config`, `/api/settle`, etc.) return 410. This reduces confusion but
is not obvious from Ledger docs alone.

See [README.md](README.md) for the operator workspace and track map.
