# Mandate

**Testnet-only, Ledger-funded access to paid agent services.** A person reviews a
spending envelope, an isolated consumer performs useful paid work through a trusted
broker, and the workspace shows the actual charges, blocked requests, settlement,
zero-refund closure, and remaining-funds recovery.

The verified workspace uses **Base Sepolia USDC** for payments, **testnet Agent0
subgraphs** for real query results, and **Hedera testnet** for authenticated evidence.
There is no mainnet mode. Ledger and x402 supply the signing and channel primitives;
Mandate supplies the constrained execution, durable accounting, recovery, and UI.

## What was demonstrated live

Two complementary Base Sepolia testnet cycles are retained.

The first 11 September 2026 run used one 0.10-USDC funding authorization,
completed three 0.01-USDC paid queries, blocked a fourth at a 0.03-USDC hourly
limit, revoked agent access, paid the merchant 0.03 USDC, and returned 0.07 USDC
to the payer. Both intermediate network failures and their recovery remain in the
evidence. The exact channel, receipts, source provenance, balances, signing report
and HCS readback are in the
[multi-call and refund proof](docs/verification/live-proof-2026-09-11.json).

A second fresh acceptance cycle used exactly one Ledger authorization and a
0.01-USDC lifetime envelope. It produced a source-bound Agent0 due-diligence
result, denied a second request without another charge, reconciled the merchant
claim and settlement, closed the fully spent Mandate without inventing a zero-value
refund, and then created a fresh unfunded Mandate while preserving the old history
in a separate read-only archive.
See the [human-readable lifecycle record](docs/LIVE-LEDGER-CYCLE-2026-09-11.md)
and [machine-readable proof](docs/verification/ledger-paid-lifecycle-2026-09-11.json).

These are real testnet operations, not unit-test fixtures. The latest post-run gate
passes `npm run verify` with 181 deterministic checks, `npm run verify:linux`
inside a no-runtime-network container, and `npm run test:ui` against a real local
HTTP/SQLite application. [Audit acceptance](docs/AUDIT-REMEDIATION.md)
separates implementation, deterministic tests, live observations, and excluded
claims.

The financial funding traces recorded **clear-basic**. Separately, a physical
Ledger Nano S+ running EthereumTest 1.23.0-dev completed the legitimate Ledger
Device SDK development path for ERC-7730: loopback test-CAL, Ledger CAL test key,
`calFilters=success`, `verdict=erc7730`, no broadcast and zero funds moved. That
is **not** production CAL or registry acceptance. The exact proof is
[`docs/verification/ledger-erc7730-device-2026-09-11.json`](docs/verification/ledger-erc7730-device-2026-09-11.json).
A fresh broker process also completed a paid call with native HID bindings disabled;
a physically unplugged or separately provisioned VPS broker was not demonstrated.
These are not interchangeable claims.

## Verify from a clean checkout without keys or funds

Use Node 22.13 or newer, npm, and the committed lockfile:

```sh
npm ci
npm run verify
npx playwright install chromium
npm run test:ui
```

The deterministic suite starts its own local services and contains isolated test
fixtures. Those fixtures do not enter the operator application or its live proof.
Browser tests operate a real local HTTP app and SQLite state; they do not intercept
network requests to invent balances or approvals.

For a fresh Linux dependency installation and an offline runtime check:

```sh
npm run verify:linux
```

That Docker build excludes local credentials, channels, device data, and evidence
logs. Its verification container has no external network. The source image and
agent runtime are pinned by digest. See [dependency security](docs/DEPENDENCIES.md)
for patched transitive dependencies, parser guards, and remaining upstream risk.

## Open the workspace without making a payment

```sh
npm run console
# In a second terminal:
npm run console:open
```

The application binds only to `127.0.0.1:8410`. The public product landing page
is served at `/`; opening the workspace from that landing page creates the local
operator session without showing or copying the token. `npm run console:open`
remains available as an explicit launcher, and removes the token from the URL
immediately. Do not copy that token, the private capability files, or the Key
Ring profile into chat, public files, or a tunnel. Startup does not sign or spend.

## Configure the real testnet stack

Prerequisites are an unlocked Ledger with Ethereum installed, password-protected
`wallet-cli` Key Ring provisioning, sealed credentials, and small testnet balances.
The CLI version used for the live proof was 2.1.0. The key password must be entered
by the operator and stored in the OS keychain, never written into a command or file.

Provisioning scripts are explicit, refuse to overwrite existing ciphertext, and
print public addresses rather than keys:

```sh
npm run mandate:keygen
npm run facilitator:keygen
```

The required sealed files are `secrets/mandate-session.enc`,
`secrets/mandate-facilitator.enc`, `secrets/mandate-authorizer.enc`, and
`secrets/graph.enc`. `secrets/hedera.enc` is needed for HCS publication. Existing
Key Ring setup tools remain available; review their prerequisites before using
one, and never delete a key that still authorizes an old channel.

Set public configuration in your process environment. For example, the Base
Sepolia RPC is `https://sepolia.base.org`; `MANDATE_SERVICE_RECEIVER` must be your
reviewed, non-payer testnet receiver. Set `MANDATE_HEDERA_ACCOUNT_ID` and
`MANDATE_HCS_TOPIC_ID` to the testnet account/topic for evidence. These are public
identifiers, not private keys. The stack can also read the allowlisted literal
public values in the ignored `.live-results/operator-ids.env` file; it does not
execute that file as shell code.

```sh
npm run boot
# In a second terminal:
npm run console:open
npm run live:readiness
```

Boot starts the facilitator on 8406, merchant on 8405, and operator on 8410. It
does not touch Tailscale or another tunnel. Do not start a second copy over a
running stack. Missing credentials or unsupported contracts produce errors, not
fake readiness or a fallback network.

## Use one reviewed authority

In the workspace, review the exact payer, recipient, token, authorizer, resource,
expiry, lifetime deposit, per-call maximum, and rolling limit. Inspecting an offer
only proposes values: it does not grant authority. Start with a small amount such
as 0.10 USDC, 0.01 per call, and 0.03 per hour.

Saving the review does not mean the Ledger signed. Explicit initial funding is
required, the actual hardware signature is checked against the expected payer,
and the channel is checked on-chain before the workspace calls it funded. Later
calls use session vouchers and do not silently top up the channel.

Create scoped agent access only after funding. With Docker running:

```sh
npm run agent -- --capability /absolute/path/printed/by/the/workspace.json --probe
npm run agent -- --capability /absolute/path/printed/by/the/workspace.json
```

The container gets only a query and a bounded IPC interface. The trusted host
relay keeps the scoped token; it exposes task submission/observation only. The
consumer has no external network, no host-data mount, no wallet password, no
Docker socket, and no authority to fund or widen scope. It produces a deterministic
comparison of live registrations; this repository does not pretend to operate an
LLM fleet.

The CLI companion uses the same authenticated broker as the UI:

```sh
npm run mandate:open -- --request-id my-stable-request-id
npm run mandate:refund -- --confirm-testnet
npm run mandate:reconcile
```

Initial CLI funding additionally requires `--authorize-funding`. Reuse a request
ID to observe an uncertain operation; do not create another charge to hide a lost
response. See [recovery](docs/RECOVERY.md).

## Security boundary and non-goals

The contract constrains the channel identity, asset, receiver and funded liability.
The broker enforces resource scope, task expiry, per-call and rolling limits, and
revocation. A UI label is not an on-chain constraint. Withdrawal delay is not task
expiry. A voucher acceptance is not a merchant bank balance or an on-chain sweep.

The operator host, local relay, RPC/contract configuration, and merchant remain
trusted components. Key Ring is not a trusted execution environment, and wiping
a Buffer cannot erase JavaScript string copies. Testnet-only does not remove
software risk. Read the [threat model](docs/threat-model.md).

Legacy version-1 `mandate.yaml` and its channel files are preserved, not silently
migrated into new spending authority. The old unauthenticated HTTP spending proxy
is retired. Optional Hedera/upto, treasury, Substreams and identity utilities are
not evidence that the verified Base Sepolia workspace exercised every optional
integration. They must remain testnet-only and have separate explicit live gates.

## Documentation

[Architecture](docs/architecture.md) · [Recovery](docs/RECOVERY.md) ·
[Ledger DX](DX.md) · [Current findings](docs/FINDINGS.md) ·
[Walkthrough](docs/WALKTHROUGH.md) · [Live Ledger cycle](docs/LIVE-LEDGER-CYCLE-2026-09-11.md) ·
[Dependency security](docs/DEPENDENCIES.md)

Upstream references, checked during remediation:
[Ledger Key Ring](https://developers.ledger.com/docs/ai-tools/ledger-cli),
[x402 batch lifecycle](https://docs.x402.org/schemes/batch-settlement), and
[Node CLI options](https://nodejs.org/api/cli.html).
