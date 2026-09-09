# Step-up on Ledger — official path (no guesswork)

Last verified against Ledger docs: 2026-09-09.

## Two different device moments (do not mix them)

| Moment | What it is | Professional API (2026) | Clear Signing without blind mode? |
|---|---|---|---|
| **1. Sign the mandate** | Open batch-settlement envelope on Base Sepolia | `@x402/evm` batch-settlement + device signs channel open (Day 2+ spine) | Via on-chain tx + ERC-7730 registry for that contract |
| **2. Step-up escalation** | Policy says `step_up` → user must tap before one payment | DMK `@ledgerhq/device-signer-kit-ethereum` | **Only** if EIP-7730 metadata is in [Ledger's registry](https://github.com/LedgerHQ/clear-signing-erc7730-registry) **or** user enables blind signing |

Mandate architecture (`docs/architecture.md`) wires step-up to DMK. That part is implemented in `packages/gateway/src/stepup*.ts`.

`docs/FINDINGS.md` lists **ERC-7730 v2 on trusted display as not load-bearing** for submission. Full registry + `originToken` is production-grade, not a same-day spike.

## What Ledger documents (authoritative)

1. **LedgerJS is deprecated** — use DMK + `device-signer-kit-ethereum` ([migration guide](https://developers.ledger.com/docs/device-interaction/dmk-ts/integration/migrations/ledgerjs-to-dmk)).

2. **Clear Signing = ERC-7730 registry entry** — wallets fetch metadata; without a matching descriptor, `signTypedData` **falls back to blind signing** ([Clear Signing overview](https://developers.ledger.com/docs/clear-signing/overview)).

3. **`originToken`** — partner token from Ledger unlocks Transaction Checks + full clear signing via context module ([for wallets guide](https://developers.ledger.com/docs/clear-signing/for-wallets)).

4. **Personal / custom messages** — `signMessage` shows text on device; arbitrary payloads are treated as non-clear unless covered by registry metadata.

5. **Device contention** — never run two device commands in parallel ([wallet-cli agent-skills](https://github.com/LedgerHQ/agent-skills)).

6. **Locked device** — do not kill the CLI while `device-state: awaiting_approval unlock`; wait for PIN ([wallet-cli agent-skills](https://github.com/LedgerHQ/agent-skills)).

## Hackathon path (today) — live-prove escalation

**Default (`MANDATE_STEPUP_MODE=clear`)** — no blind signing:

1. Gateway prints payment context (amount, recipient, policy reason)
2. DMK `getAddress({ checkOnDevice: true })` — **Clear Signing** address verify on device
3. User taps Approve → escalation cleared

**Full message on device (`MANDATE_STEPUP_MODE=message`)** — needs blind signing OR ERC-7730 registry.

Prerequisites:

1. Ethereum app installed + open on device
2. `export WALLET_PASS=…` and `npm run ledger:reset`
3. `export MANDATE_ETH_APP_OPEN=1`

Run:

```bash
export MANDATE_ETH_APP_OPEN=1
npm run e2e:stepup
```

Approve on device → expect `STEPUP_OK`.

## Production path (post-hackathon)

1. Author ERC-7730 JSON for Mandate's EIP-712 domain (`MandateStepUp` or contract calldata).
2. Open PR to `LedgerHQ/clear-signing-erc7730-registry`.
3. Obtain `originToken`; pass to `SignerEthBuilder({ dmk, sessionId, originToken })`.
4. Use `signTypedData` with registered domain → Clear Signing on Secure Screen, blind signing off.

## What Mandate already proved (evidence)

| Gate | Command | Status |
|---|---|---|
| Ledger detection / sleep | `npm run ledger:check` | ✅ `genuine: true` (~6s) |
| Reputation | `npm run probe:reputation` | ✅ `REPUTATION_OK` |
| Step-up unit path | hermetic suite (injected device fns) | ✅ 32/32 |
| Step-up live device tap | `MANDATE_ETH_APP_OPEN=1 npm run e2e:stepup` | ✅ `STEPUP_OK` (clear mode, 2026-09-09) |
