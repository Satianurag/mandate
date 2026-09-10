# Step-up on Ledger — official path (no guesswork)

Last verified against a live Nano S+: 2026-09-10.

## Two different device moments (do not mix them)

| Moment | What it is | Professional API (2026) | Clear Signing without blind mode? |
|---|---|---|---|
| **1. Sign the mandate** | Open batch-settlement envelope on Base Sepolia | `@x402/evm` batch-settlement + device signs EIP-3009 USDC `ReceiveWithAuthorization` | Live: **BASIC** structured EIP-712 (`npm run e2e:erc7730-device`). Labeled ERC-7730 needs CAL filters + `originToken` (F32) |
| **2. Step-up escalation** | Policy says `step_up` → user must tap before one payment | DMK `@ledgerhq/device-signer-kit-ethereum` | Address-verify (`getAddress({ checkOnDevice: true })`). MandateStepUp has no verifying contract |

Mandate architecture (`docs/architecture.md`) wires step-up to DMK. That part is implemented in `packages/gateway/src/stepup*.ts`.

`docs/FINDINGS.md` lists **ERC-7730 v2 on trusted display as not load-bearing** for submission. Full registry + `originToken` is production-grade, not a same-day spike.

## What Ledger documents (authoritative)

1. **LedgerJS is deprecated** — use DMK + `device-signer-kit-ethereum` ([migration guide](https://developers.ledger.com/docs/device-interaction/dmk-ts/integration/migrations/ledgerjs-to-dmk)).

2. **Clear Signing (ERC-7730)** — CAL-signed filters for labeled fields. Without matching descriptors **and** a partner `originToken`, DMK still takes the **BASIC** structured EIP-712 path (`provideContext` + `signTypedData`), not hashed `signTypedDataLegacy`. Live proof: `npm run e2e:erc7730-device` → `calFilters=error`, `verdict=clear-basic`.

3. **`originToken`** — partner token from Ledger unlocks Transaction Checks + CAL `/dapps` (header `X-Ledger-Client-Origin`). Wired in `origin-token.ts` via `LEDGER_ORIGIN_TOKEN` or Key Ring `secrets/ledger-origin.enc`. Unset on the operator machine (CAL HTTP 403). Enroll: [for wallets](https://developers.ledger.com/docs/clear-signing/for-wallets).

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

## Production path (labeled ERC-7730)

1. Partner `originToken` from Ledger → `LEDGER_ORIGIN_TOKEN` or seal as `ledger-origin`.
2. CAL must return EIP-712 filters for Circle USDC `ReceiveWithAuthorization` on 84532 (the actual mandate tap).
3. Registry PR 2972 is for **Voucher/Refund** (session-key types), not the Ledger deposit. Do not treat merge as labeling the mandate-open screen.
4. `npm run e2e:erc7730-device` must print `ERC7730_DEVICE_CLEAR` (`calFilters=success`) before any claim of labeled fields.

## What Mandate already proved (evidence)

| Gate | Command | Status |
|---|---|---|
| Ledger detection / sleep | `npm run ledger:check` | ✅ `genuine: true` (~6s) |
| Reputation | `npm run probe:reputation` | ✅ `REPUTATION_OK` |
| Step-up unit path | hermetic suite (injected device fns) | ✅ 32/32 |
| Step-up live device tap | `MANDATE_ETH_APP_OPEN=1 npm run e2e:stepup` | ✅ `STEPUP_OK` (clear mode, 2026-09-09) |
| Mandate EIP-3009 on Nano S+ | `MANDATE_ETH_APP_OPEN=1 npm run e2e:erc7730-device` | ✅ `ERC7730_DEVICE_BASIC` (`calFilters=error`, 2026-09-10) — not labeled ERC-7730 |
