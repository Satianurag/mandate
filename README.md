# Mandate

Ledger-approved autonomous x402 agents on **Base mainnet** (chain 8453) with native USDC. One local workspace, one port.

ETHOnline 2026 Continuity submission for **Ledger**, **The Graph**, and **Hedera**. This repository existed before the event. Only event-period work is judged.

**Deadline:** Sunday 13 Sep 2026, 12:00 pm EDT — public GitHub repo + per-track demo videos.

## Run

Node 22.13+:

```sh
npm ci
npm start   # also starts the self-hosted facilitator on :8406 when secrets exist
```

Open http://127.0.0.1:8410/. Startup does not unlock a wallet, sign, or spend.

Workspace config lives in `state/mainnet/operator/setup-draft.json` (not `mandate.yaml` — the legacy YAML gateway was removed).

## How it works

Same shape as a reliable x402 agent loop: describe a goal, unpaid-probe prices, approve a plan, pay sequential tools inside a budget, checkpoint, compose a report from evidence.

1. **Settings:** Vertex Gemini (gcloud), Base mainnet RPC, x402 facilitator, existing Ledger Key Ring key.
2. **Ledger budget:** read the device address, set limits, prepare a Key Ring–sealed spending wallet. Review and fund the allowance on Ledger. Agents cannot raise that cap.
3. **New task:** create an agent for this goal and tool set. Preview unpaid offers. Start. When the run ends, the agent is discarded. Receipts and the report remain.
4. Paid tool calls use the sealed software wallet. Ledger is required again only for allowance increases.

The broker enforces endpoints, recipients, per-call/rolling limits, and expiry. Those rules are not hardware-enforced.

## Architecture

- `scripts/start.mjs` → operator on 8410, state in `state/mainnet/operator`
- Gateway broker: SQLite reservations, x402 exact EVM, DMK signing for funding
- Key Ring (`wallet-cli ring`) seals the spending key; decrypt does not need USB after `ring init`
- First-party Graph / Agent0 tools and optional Hedera rail
- Self-hosted facilitator in `packages/facilitator` (auto-started on `http://127.0.0.1:8406` when `secrets/mandate-*.enc` exist; default in Settings)
- Graph Substreams artifact in `substreams/x402-payments`

## Continuity (before / after)

**Before:** Mandate was a scoped x402 workspace with Ledger funding experiments and separate specialist templates.

**After (this event):** one mainnet workspace; ephemeral per-task agents; plan → probe → pay → compose; Key Ring + DMK as the trust layer; Graph as load-bearing evidence; Hedera x402/HCS on the submitted path.

Live Ledger funding is a separate operator action. Older Sepolia experiments are not proof of this binary.

HCS topic submits are compiled in but do not broadcast unless `MANDATE_HCS_LIVE=1` is set.

Clear-signing on this machine uses the Ethereum app from `ledger-dev` (`CAL_TEST_KEY=1`):

```sh
npm run ledger:test-cal
MANDATE_LEDGER_TEST_CAL_URL=http://127.0.0.1:8427 npm start
```

Open that development Ethereum app on the Ledger before funding. A partner `LEDGER_ORIGIN_TOKEN` is the production alternative.

## Track qualification map

| Track | What judges need | Where in this repo |
|-------|------------------|-------------------|
| **Ledger Continuity** | Agent Stack + `wallet-cli ring`; device confirmation before funds move; x402 payments; DX feedback | DMK (`dmksigner.ts`, `agent-funding.ts`), Key Ring (`keyring.ts`), operator UI (`console/`), [DX.md](DX.md) |
| **Graph Continuity** | Graph load-bearing; **live data** (mocks don't qualify); meaningful analysis | `discovery.ts`, `mcp.ts`, `agent-live-providers.ts`, `analytics.ts`, `reputation.ts`, Substreams source |
| **Hedera Continuity** | Substantive new Hedera integration during event | `agent-hedera.ts`, `hedera.ts`, `hcs-anchor.ts`, native `hedera:mainnet` in `agent-exact.ts` |

## Dev probes (no funding required)

Manual checks before Phase 9 live proofs:

```sh
node scripts/dev/probe-unpaid-x402.mjs    # third-party 402 offers, paymentMade: false
node scripts/dev/probe-unpaid-plan.mjs    # Vertex plan preview without settlement
node scripts/dev/probe-ledger-preflight.mjs
```

## Submission checklist

- [ ] Public GitHub repo linked in Hacker Dashboard
- [ ] Ledger: paste [DX.md](DX.md) into partner form; device on camera in video
- [ ] Graph: 2–4 min demo showing **live** Graph query in the run
- [ ] Hedera: ≤5 min video focused on new Hedera rail / HCS hook
- [ ] `npm run verify` green on a clean clone

## Ledger DX

See [DX.md](DX.md).
