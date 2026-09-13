# Mandate

Ledger-approved autonomous x402 agents on **Base mainnet** (chain 8453) with native USDC. One local workspace, one port.

ETHOnline 2026 **Start Fresh** submission for **Ledger** (AI Agents × Ledger), **The Graph**, and **Hedera**. Built during the event. Device-backed security is the product: Key Ring holds the spending key, DMK confirms funding, the model never sees a secret.

**Deadline:** Sunday 13 Sep 2026, 12:00 pm EDT — public GitHub repo + 2–4 minute demo video.

## Run

Node 22.13+:

```sh
npm ci
npm start   # also starts the self-hosted facilitator on :8406 when secrets exist
```

Open http://127.0.0.1:8410/. Startup does not unlock a wallet, sign, or spend.

Workspace config lives in `state/mainnet/operator/setup-draft.json`.

## How it works

Describe a goal, unpaid-probe prices, approve a plan, pay sequential tools inside a budget, checkpoint, compose a report from evidence.

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
- Graph Substreams source in `substreams/x402-payments` (supporting artifact; live Graph proof is Subgraph MCP + Agent0)

Clear-signing uses either a partner `LEDGER_ORIGIN_TOKEN` or the ledger-dev Ethereum app with a loopback CAL:

```sh
npm run ledger:test-cal
MANDATE_LEDGER_TEST_CAL_URL=http://127.0.0.1:8427 npm start
```

Open that development Ethereum app on the Ledger before funding.

HCS topic submits are compiled in but do not broadcast unless `MANDATE_HCS_LIVE=1` is set.

## Track qualification map

| Track | What judges need | Where in this repo |
|-------|------------------|-------------------|
| **Ledger — AI Agents × Ledger** | Agent Stack + `wallet-cli ring`; device confirmation before funds move; x402 payments; DX feedback | DMK (`dmksigner.ts`, `agent-funding.ts`), Key Ring (`keyring.ts`), operator UI (`console/`), [DX.md](DX.md) |
| **The Graph — AI From Scratch** | Graph load-bearing; **live** data (mocks don't qualify); meaningful analysis | `discovery.ts`, `mcp.ts`, `agent-live-providers.ts`, `analytics.ts`, `reputation.ts` |
| **Hedera — agentic payments** | Native `hedera:mainnet` x402 rail on the submitted path | `agent-hedera.ts`, `hedera.ts`, `hcs-anchor.ts`, `agent-exact.ts` |

This is not a Continuity submission. Do not describe the repo as pre-event work.

## Dev probes (no funding required)

```sh
node scripts/dev/probe-unpaid-x402.mjs    # third-party 402 offers, paymentMade: false
node scripts/dev/probe-unpaid-plan.mjs    # Vertex plan preview without settlement
node scripts/dev/probe-ledger-preflight.mjs
```

## Submission checklist

- [ ] Public GitHub repo linked in Hacker Dashboard (**Start Fresh**)
- [ ] Ledger Track 01: paste [DX.md](DX.md) into the partner form; device on camera in the video
- [ ] Graph: 2–4 min demo showing a **live** Graph query in the run
- [ ] Hedera: only claim a live paid request if it is on camera (Blocky402 if required by that prize)
- [ ] `npm run verify` green on a clean clone

## Ledger DX

See [DX.md](DX.md). Ledger-only; paste that file into the partner form.

## AI use

See [AI.md](AI.md).
