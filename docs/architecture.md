# Architecture — which rail does what

Locked after live verification on 2026-09-08 (`docs/FINDINGS.md`).
**Everything runs on testnet.** No mainnet dependency except one optional
$0.01 proof-of-integration payment.

## Rails

| Purpose | Scheme / network | Facilitator | Cost |
|---|---|---|---|
| **The mandate envelope** | `batch-settlement@eip155:84532` (Base Sepolia) | x402.org | testnet, free |
| **Hedera paid service** | `exact@hedera:testnet` | Blocky402 *(required by the Hedera track)* | testnet, free |
| **Evidence log** | HCS topic, Hedera testnet | — | testnet, free |
| Graph proof-of-integration *(optional)* | `exact@eip155:8453` (Base mainnet) | Graph gateway | **0.01 USDC real** |
| Graph bulk reads | authenticated gateway, API key sealed in Key Ring | — | free tier |

### Why the envelope is not on Hedera

No public facilitator advertises `batch-settlement` on Hedera — only on Base
Sepolia. Putting it there would mean deploying escrow contracts *and*
self-hosting a facilitator. Possible (Hiero relay verified, chainId 296) but a
Day-4 stretch, not the critical path.

**This is a feature, not a compromise.** The mandate layer is rail-agnostic by
design: the same policy engine and the same device signature govern a
batch-settlement channel on Base Sepolia and an `exact` transfer on Hedera. A
single-rail demo would not prove that.

### Why the envelope is not against The Graph's gateway

Their gateway offers `exact` only — batch settlement needs server-side support
they do not have, which is exactly what their forum post asks someone to build.
We run the scheme on our own service and hand them the reference implementation.

## Request path

```
agent
  │  ordinary HTTP
  ▼
Mandate gateway ─── policy engine ──► ERC-8004 reputation (Agent0 / Subgraph MCP)
  │                     │
  │                     ├─ allow    ─► sign voucher (no device)      ─┐
  │                     ├─ step_up  ─► DMK device action, ERC-7730   ─┤
  │                     └─ deny     ─► refuse, no signature produced  │
  │                                                                   ▼
  │                                              facilitator /verify → /settle
  ▼                                                                   │
upstream service                          HCS evidence topic ◄────────┘
```

## Non-negotiable invariants

1. **No plaintext secret on disk or in the environment.** Key Ring only.
2. **Every failure degrades toward `deny`.** Unreachable subgraph, unparseable
   price, absent device — none may open the gate.
3. **Never hardcode a fee payer.** Two facilitators advertise two different ones for the same network. Always read it from the live challenge's `extra`.
4. **Never branch on `res.ok` against The Graph.** It returns HTTP 200 with an error body. Inspect the body, never the status alone.
5. **A facilitator 500 is a hard failure, not a retry.** An undecodable
   transaction returns 500, and retrying can double-spend the intent.
6. **The agent never holds a key that can alter its own mandate.**

## Track coverage

| Sponsor | Requirement | Where satisfied |
|---|---|---|
| Ledger | Key Ring CLI, device approval, x402 payment flow | custody + step-up + envelope |
| The Graph | compose 2+ products; live data | Agent0 + Subgraph MCP + Substreams + x402 gateway |
| The Graph | Subgraph MCP **or** Substreams **or** x402 | all three |
| Hedera | live x402 service via Blocky402 | Hedera paid service |
| Hedera | HCS audit, scheduled tx, ERC-8004/HCS-14 (bonus) | evidence layer, treasury leg, identity |
