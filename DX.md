# Ledger integration and developer-experience report

**Observed on 11 September 2026.** These are reproducible integration observations,
not claims that every upstream behavior is a defect or that descriptors reached a
device. The canonical execution evidence is
[`docs/verification/live-proof-2026-09-11.json`](docs/verification/live-proof-2026-09-11.json).

## Integration actually used

The operator host ran wallet-cli 2.1.0, Device Management Kit 1.9.0, Ethereum Signer
Kit 1.18.0, Context Module 2.5.0, x402 2.25.0, viem 2.56.3 and Hiero SDK 2.88.0.
The lockfile and dependency-security report record transitive updates separately.
Tests ran on the Mac and in a clean Node 22 Linux container without host credentials.

Key Ring seals the delegated session, facilitator, authorizer and service credentials.
The trusted broker invokes `wallet-cli ring decrypt` over pipes, uses the material
for an operation, and wipes the original Buffer afterwards. That cleanup is not a
promise that JavaScript strings or account closures have been erased.

DMK resolves the configured Ledger address, requests the actual EIP-712 funding
authorization, and verifies the returned signature against that principal. The live
0.10-USDC funding then supported three 0.01-USDC calls without another payer signature.
The consumer never received the Key Ring password, wallet key or Docker authority.

## Findings that help an integrator

### 1. Device presence is not approval of an action

**Expected:** approval binds the action, amount, receiver, network and freshness.
**Pre-audit behavior:** address confirmation was presented as consent to a payment
whose context appeared only in the host terminal.
**Current behavior:** action approvals require a real expected-principal signature,
action digest, nonce and expiry; the nonce is consumed transactionally. Presence is
separate and its signature is cryptographically checked. The main batch workspace
blocks an exhausted scope instead of pretending an address check widened it.

Reproduce the rejection boundaries with `stepup.test.ts` and `presence.test.ts`.
Those use real ephemeral cryptographic signatures as test inputs; they do not claim
that a physical device was used in the deterministic suite.

### 2. Report the actual clear-signing path

The live funding trace reported `originTokenPresent=false`, `calFilters=error`,
and `verdict=clear-basic`. The signature was valid and the channel funded, but that
is not evidence that CAL/ERC-7730 field labels appeared on the device. The application
persists the report next to the funding signature's digest.

`npm run verify:descriptors` separately runs the official linter on the USDC and
batch descriptors. Missing tooling exits nonzero; schema-only validation must be
requested explicitly and is labeled schema-only. Full local lint passed during this
run. Registry acceptance and hardware rendering are not inferred from that result.

Useful upstream improvement: make the distinction between generic clear signing,
legacy paths, CAL filters, and successfully provided device context conspicuous in
integrator-facing results. This is integration feedback, not an assertion that the
current SDK is unsafe merely because optional context resolution failed.

### 3. Be precise about headless behavior

The Ledger documentation describes device-free Key Ring decryption after member
provisioning. That does not automatically mean an application can restart without
constructing a device signer. The original `openMandate` always did so.

`resumeMandate` now has no payer signing capability and needs an existing pinned,
funded channel. A fresh process with `node --no-addons` completed a real paid request
with zero new Ledger signatures. This proves that broker restart path with native
HID unavailable to that process. The Ledger remained connected to the Mac; a physically
unplugged host or separately provisioned VPS was not part of the completed live proof.
A proposed cross-host member-profile handoff was not executed. No credential export
is hidden behind the headless claim.

### 4. Preserve identity and signature encoding

The adapter joins DMK signature fields into the format expected by the stock x402
client, normalizes the recovery byte, rejects unsupported chains before signing,
and verifies the returned address. Unit regressions cover short `r`/`s` fields and
recovery-byte normalization. Do not bypass these checks with success-shaped strings.

### 5. Authentication must extend beyond encrypted key storage

Ledger documents that another process running as the same user can inspect the CLI
password environment. Mandate's consumer therefore runs in a separate constrained
Docker execution environment. The observed boundary checks covered network isolation,
non-root/read-only execution, absence of host-data mounts/passwords, and rejection of
operator, funding, mainnet-override and wider-query requests. Encryption alone is not
the claimed isolation mechanism.

## Operational failures retained as evidence

A claim succeeded before an immediate merchant sweep failed. Recovery now reads
already-claimed revenue and sweeps it without requiring a new voucher. A refund
succeeded before a public RPC returned `block not found`; the original transaction
was later reconciled by parsing its multicall, transfers and consistent snapshots.
Some HCS submissions returned `UNKNOWN`; the outbox retained them and readback-aware
retries completed their anchors. These are payment/RPC integration observations,
not Ledger device defects. The failed attempts remain in the recorded history.

## Verification commands

`npm run verify` checks deterministic security and lifecycle behavior.
`npm run test:ui` checks the real local HTTP workspace in Chrome/Chromium.
`npm run verify:linux` performs a clean install and offline execution check.
`npm run verify:descriptors` checks the current descriptors with the official tool.
Live signatures or funds are requested only through the reviewed operator workflow;
none of these deterministic commands are a disguised payment operation.

Primary sources:
https://developers.ledger.com/docs/ai-tools/ledger-cli
https://docs.x402.org/schemes/batch-settlement
https://nodejs.org/api/cli.html
