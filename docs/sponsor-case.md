# Why each sponsor wants this

A sponsor is not buying a clever demo. They are buying a story they can retell
to developers, to their board, and in a launch post. This file is the argument,
kept separate from the build plan so it can be lifted straight into the
submission text and the video script.

## Ledger — the quarter they are shipping right now

Ledger published a [2026 AI Security Roadmap](https://www.ledger.com/blog-2026-ai-security-roadmap)
on 14 April 2026 with dated quarterly deliverables:

| Quarter | Deliverable | Status |
|---|---|---|
| Q2 2026 | Agent Identity; Agent Skills & CLI | shipped |
| **Q3 2026** | **Agent Intents; Agent Policies** | **this quarter** |
| Q4 2026 | Proof of Human | unreleased |

Their own description of Agent Policies: *"hardware-managed boundaries.
Administrators define spending limits or interaction constraints (e.g. 'Maximum
$500/day'). A Hardware Security Module automatically escalates policy violations
to human review."*

That is this product. Mandate is a public, open-source, third-party reference
implementation of Ledger's own Q3 deliverable, built during their own hackathon.

**Commercial motive.** Ledger's addressable market today is people who already
own crypto. Their 2026 bet is that every AI agent developer becomes a customer —
CEO Pascal Gauthier's "Revenge of the Atoms", and Chief Human Agency Officer Ian
Rogers' "lethal trifecta" of prompt injection, autonomous execution, and access
to real resources. Outside their own walls they can currently point to MoonPay
and Shisa AI. That is a thin evidence base for a TAM expansion of that size.

**Two extras they get.**

- A **second production use for the Ledger Key Ring Protocol**. LKRP is patented
  Ledger technology whose only shipped application so far is Ledger Sync.
- **ERC-7730 v2 descriptors for a live contract** — exactly what Ledger asked
  builders for when it handed Clear Signing to the Ethereum Foundation:
  *"Protocol developers should provide clear descriptions of contract
  interactions using available tooling."*

## The Graph — the fix for a shipped product nobody uses

The Graph launched an x402 pay-per-query gateway. A community member then posted
the numbers on [their own forum](https://forum.thegraph.com/t/whats-actually-blocking-x402-adoption-on-the-graph-awareness-discovery-and-one-round-trip-payments/7009):

| Metric | Value |
|---|---|
| Total x402 revenue on The Graph's gateway | **$2.22** |
| Payments / distinct agents | 222 / 29 |
| x402 volume across Base, same period | $42M+ |
| Subgraphs an agent must choose between | 15,000+ |

Three named blockers, and what Mandate does about each:

1. **Awareness** — agent frameworks surface nothing about it.
   → We package the client as an MCP skill that frameworks discover.
2. **Discovery** — *"which of 15,000+ subgraphs answers its question?"*
   → We need a semantic resolver to function at all, so we build one.
3. **Payment architecture** — per-call settlement adds latency and an on-chain
   event to every $0.01 read. The post explicitly recommends adopting
   `batch-settlement`.
   → Batch settlement is the core of our design, not an add-on.

We are not asking The Graph to care about our project. We are handing them the
three fixes their own community asked for.

## Hedera — evidence, and a first

Hedera's 2026 positioning is enterprise trust for the agentic economy. Accenture
joined the Council in April 2026 specifically to work on agentic AI and
AI-driven payments for financial services clients.

Enterprises do not buy autonomy. They buy **auditability** — the ability to
answer "what did the agent do, under whose authority, and can you prove it."
Consensus timestamps on HCS answer that in a way no application log can.

**A stretch goal, honestly labelled.** No public facilitator advertises
`batch-settlement` on Hedera — only on Base Sepolia (verified 2026-09-08). So a
batch-settlement channel on Hedera would mean deploying the escrow contracts
*and* self-hosting a facilitator. The Hiero JSON-RPC relay is live (chainId 296)
so it is genuinely possible, but it is a Day-4 stretch, **not** a load-bearing
claim and not something to put in the pitch until it runs.

The Hedera track is fully satisfied without it: a live `exact` service through
Blocky402 plus the HCS evidence layer. See `docs/architecture.md`.
