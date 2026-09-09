# Mandate

**Approve once on your Ledger. Your agent then works at machine speed inside a
signed, budget-capped envelope it cannot widen.**

ETHOnline 2026 — Ledger, The Graph, Hedera.

---

## The arithmetic problem

Hardware approval is per-transaction. Agents act thousands of times per hour.

A research agent doing one task might make four hundred sub-cent data queries.
Nobody taps a device four hundred times. So every agent framework does the only
thing left: it puts a hot key in an environment variable and hopes. Ledger names
the consequence directly — *"these keys are 'hot', meaning they are online and
connected to the internet."*

That mismatch, not a lack of ideas, is why hardware security has not reached AI
agents.

## The move

Stop approving **transactions**. Approve a **mandate**: one hardware-signed
envelope with a budget, a scope, an expiry and an escalation rule. The agent
runs freely inside it, cryptographically unable to exceed what the human
authorized. The device is consulted again only when the agent tries to leave.

This needs no new infrastructure. The x402
[`batch-settlement`](https://x402.org/x402-batch-settlement/) scheme already
does it: the buyer deposits into an on-chain escrow once, then signs off-chain
cumulative vouchers per request, which the server verifies with *"simple
signature math, with no chain lookups required during the request"* and redeems
in batches later.

Read that as a security primitive rather than a payments optimisation:

| Batch settlement | Ledger Agent Policy |
|---|---|
| escrow deposit | budget |
| cumulative voucher | metered consumption |
| `withdrawDelay` | expiry |
| refund path | revocation |
| per-request ceiling | scope |

**The x402 escrow channel is the on-chain expression of a Ledger Agent Policy.**
One device tap opens it. Everything afterwards is bounded by that signature.

## Ledger's own triad, one sponsor per layer

From [Mapping the Agentic AI Infrastructure Landscape](https://www.ledger.com/blog-mapping-the-agentic-ai-infrastructure-landscape):

| Ledger's words | Layer | Owner |
|---|---|---|
| "Identity tells you who the agent is" | ERC-8004, hardware-anchored, resolved via Agent0 subgraphs | The Graph |
| **"Authorization tells you what it's allowed to do"** | **The mandate — Clear-signed, enforced by an escrow ceiling** | **Ledger** |
| "Evidence proves what it actually did" | Every decision and voucher on an HCS topic | Hedera |

Ledger states they solve the middle row — *"runtime control, the unsolved
problem others circle around"* — and treat the outer two as complementary.

## The mandate

```yaml
mandate: research-agent-07
principal: did:ledger:zQ3sh…        # hardware-anchored, ERC-8004 registered
expires: 2026-09-14T12:00:00Z       # becomes the channel withdrawDelay

budget:
  ceiling: 50 USDC                  # becomes the escrow deposit
  window: 24h
  escalate_at: 90%

allow:
  - graph.query:
      max_price: 0.01 USDC          # per-request ceiling; server may charge less
      subgraphs: [verified, agent0/*]

escalate:                           # → device tap required
  - counterparty.erc8004.score < 0.7
  - counterparty.registered == false

deny:                               # → refused, no signature produced
  - counterparty.feedback.revoked
  - quoted_price > advertised_price * 1.5
```

Every field maps to something real. Nothing is decorative.

## No `.env`

There is deliberately no `.env` and no secret in the environment. Credentials are
sealed with `wallet-cli ring encrypt` and unsealed for the lifetime of a single
operation, then zeroed. A blob sealed once with the device attached opens later
on a VPS with no device present.

## Getting started

```bash
npm install
npm run preflight          # toolchain, Key Ring, facilitator, Graph key
npm test --workspaces      # hermetic suite, zero env required
```

`preflight` seals and unseals a throwaway value with no device attached, and
confirms the Blocky402 testnet facilitator advertises Hedera. Verified:
`hedera:testnet`, scheme `exact`, feePayer `0.0.7162784`.

The mandate demo (one tap, then vouchers):

```bash
npm run mandate:keygen && npm run facilitator:keygen
# fund the payer with Base Sepolia USDC + the submitter with ETH (links printed)
cp mandate.example.yaml mandate.yaml   # set salt + receiver
npm run check:mandate && npm run mandate:open
```

## Status

| Component | State |
|---|---|
| Policy engine | implemented, hermetic suite green, F18 hybrid locked in |
| Key Ring custody | **provisioned and proven headless (F11)** |
| Reputation lookup (Agent0) | implemented; Hedera `0.0.x` → EVM alias resolution (F20) |
| Device step-up (DMK) | implemented, live `STEPUP_OK` (clear mode) |
| Mandate client (`DmkEvmSigner` + ceiling strategy) | implemented; live proof = `npm run mandate:open` |
| Self-hosted facilitator + mandate service | implemented, strict-booting; live proof = `npm run mandate:open` |
| HCS audit (payments + mandates) + mirror read-back | implemented — needs topic id; Key Ring creds only |
| Hedera paid service (Blocky402) | implemented — fee payer resolved live at boot, fails fast |
| Operator console | **not started** (per user: no UI until requested) |

- [`docs/sponsor-case.md`](docs/sponsor-case.md) — why each sponsor wants this
- [`docs/plan.md`](docs/plan.md) — day-by-day, with the cut order
- [`docs/architecture.md`](docs/architecture.md) — which rail does what, and the invariants
- [`docs/FINDINGS.md`](docs/FINDINGS.md) — running log of everything measured live
- [`docs/threat-model.md`](docs/threat-model.md) — what this does *not* fix

## Scope of the claim

Mandate bounds what an agent can spend and removes plaintext keys from the host.
It does **not** fix the facilitator vulnerabilities found across all 15 audited
x402 facilitators; those live in the facilitator. It caps the blast radius. It
also does not read the agent's mind: a prompt-injected agent can still spend the
budget on garbage. What is guaranteed is that the loss is capped at what a human
deliberately authorized, is refundable through the channel, and is fully
reconstructable from the HCS log.

## Licence

MIT.
