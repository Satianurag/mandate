# Threat model

State this honestly in the README and in the demo. Judges reward a team that
knows the boundary of its own claims.

## What Mandate fixes

**Plaintext keys on the agent host.** Ledger's own framing of the problem:
"If an AI agent is spending money, it needs access to a private key to sign
transactions. By definition, these keys are 'hot'." Mandate removes them from
disk and from the environment. Secrets live sealed in the Ledger Key Ring and
exist as plaintext only inside a single `withSecret` callback.

**Unbounded autonomous spend.** A rolling budget and a per-call ceiling, with
escalation to a physical device confirmation. This is the direct answer to
incidents like the February 2026 OpenClaw agent, which mis-parsed a request for
4 SOL and transferred its entire ~$250k token holding.

**Blind counterparty trust.** Stock x402 clients pay whoever answers with a
402. Mandate resolves the payee against the ERC-8004 registries first.

**Unverifiable decision history.** Consensus timestamps on HCS give an ordering
no application log can forge or backdate.

## What Mandate does NOT fix

**Facilitator vulnerabilities.** The 2026 audit of 15 facilitators found
violations in every one of them — free shopping, asset theft, gas abuse,
service denial (arXiv:2607.19545). Those live in the facilitator's own verify
and settle logic. Mandate is a client. It cannot patch a server it does not
run. What it does do is bound the blast radius: a compromised facilitator can
still misbehave, but it cannot spend more than the policy window allows, and
every attempt is on the consensus record.

**Prompt injection into the agent.** If the agent is manipulated into wanting
to pay a legitimate, well-reputed service for something useless, policy allows
it. Reputation scores the counterparty, not the intent. The per-call ceiling
and rolling budget are the only defence here, and they are a cap, not a cure.

**A compromised Mandate host.** An attacker with code execution on the gateway
can observe the unsealed key during its lifetime in memory. The Key Ring
protects secrets at rest and in transit between machines. It does not create a
TEE.

**Step-up binding in clear mode.** The default step-up verifies the address on
the device screen (presence + tap) but does not produce a signature over the
amount and recipient — that binding exists only in message/EIP-712 mode, which
needs blind signing until the ERC-7730 registry entry merges. On a compromised
host, a tap obtained for one payment context could be followed by a different
payment. The console display is the human's only check in clear mode.

**The password.** `WALLET_PASS` must come from the OS keychain. Written into a
command it lands in shell history, the process list, and CI logs — at which
point the ciphertext is openable by whoever reads them.

## Failure direction

Every degraded path resolves toward refusal:

| Failure | Result |
|---|---|
| Subgraph unreachable | counterparty treated as unregistered → `step_up` |
| Device absent, locked, or timed out | `deny` |
| Amount unparseable | `deny` |
| HCS write failing | queued and retried; never blocks or opens the gate |

The one asymmetry worth naming: a stale Agent0 subgraph ID returns an empty
result rather than an error, which silently degrades every counterparty to
"unrated" and turns every allow into a step-up. Noisy, not dangerous — but
re-resolve the IDs on Day 3.
