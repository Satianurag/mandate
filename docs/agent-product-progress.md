# Agent product acceptance - 12 September 2026

## Status

The two specialists, saved custom agents, adaptive runtime, real testnet providers,
Ledger funding review, explicit operator-approved allowance increases, shared
accounting, native Hedera payments, report-first UI, receipt recovery and
unused-funds return are implemented. The project is **partially
live-verified**, not declared complete across every hardware/network path.

A real Protocol Investigator run purchased five useful responses across Base
Sepolia and native Hedera. Its original final model generation reached MAX_TOKENS.
The evidence was retained and the report was recovered without purchasing those
services again. The final specialist summary is rendered from observed fields,
with unknown causes and valuation-quality limits stated explicitly. Its audit trail
still says `partial`; it was not relabeled as a flawless completed run.

## Fresh live evidence

The sanitized record is
[`verification/agent-paid-proof-2026-09-12.json`](verification/agent-paid-proof-2026-09-12.json).
The underlying retained authorizations, responses and independent readbacks remain
in ignored local state. No private key, operator token or full signing payload is
published in the sanitized record.

| Verified item | Observed result |
| --- | --- |
| Ledger-funded software wallet | 0.25 test USDC credited on Base Sepolia; authorization and transfer independently matched |
| Stored device report | `clear-basic`; ERC-7730 reported unsupported for this run, not rich display of every policy field |
| Graph protocol requests | Three real paid responses, 0.003 test USDC total |
| Native Hedera Evidence Lab | One real paid response, 0.002 test USDC; SDK transaction and Mirror transfers independently matched |
| Market-data service | One real paid response, 0.001 test USDC; Mandate is the merchant, Coinbase is the upstream data source |
| Total service spending | **0.006 test USDC**, five paid requests across three service types |
| Remaining shared authority at readback | 0.244 test USDC |
| EVM software-wallet balance at readback | 0.246 test USDC; native Hedera spending debited a separate account |
| Report recovery | No additional x402 payment; final observed-field rebuild also made zero model requests |
| Vertex reasoning | Gemini 3.5 Flash produced real valid actions; inference is billed separately from test-USDC spending |

Independent readback checks the intended payer, receiver, asset, amount and
transaction/authorization, rather than accepting only a facilitator success flag.
This is fresh agent-path evidence, separate from the older batch-channel proofs.
It does not establish a successful live return of unused funds or every template.

## Verification completed

The final `npm run verify` gate passed **228 automated tests**:
208 gateway/runtime tests, five policy tests, six service tests, two mandate-service
tests, four security-ratchet tests and three source-resolution tests. TypeScript
builds, descriptor/schema validation and release-consistency checks also passed.
The release check found no credential-shaped literals or local-path leaks in the
checked source set. This is not a claim of zero dependency vulnerabilities.

Browser verification is separate from those unit/integration counts:

- The legacy browser suite passed, including its funding/recovery regressions,
  desktop/mobile behavior and accessibility checks.
- The new isolated browser fixture passed for **both specialists and a custom
  agent created through the form**. It exercises the real operator, SQLite,
  runtime, SDK serialization, accounting, report export, reload and cancellation
  with explicitly simulated model/settlement. The second specialist uses a
  candidate ID from its preceding observation, not a hardcoded production result.
- The actual prepared workspace passed desktop/mobile navigation and accessibility
  checks. Saving/editing a custom agent persists across reloads. This check does
  not initiate funding or a paid run.
- The actual recovered live report passed desktop and mobile checks with no
  horizontal page overflow or serious/critical accessibility violations. Its five
  real receipts remained unchanged during that read-only inspection.

Fixture screenshots/results are labeled and stored separately from the actual live
report under `.live-results/agent-integration`. A test-double settlement is never
presented as evidence of a real chain payment.

## Important implementation boundaries

The Ledger signs funding, not every application policy rule. Key Ring protects
software-key storage; the trusted broker enforces service scope, recipients,
shared/run budgets, expiry and revocation. The native Hedera wallet is separately
reviewed, not bridged from the EVM wallet or claimed to be hardware-held.

Reservations are durable before signing. A lost merchant response can be recovered
through a read-only original-response lookup. When its cache is lost, the retained
native transaction or a verified EVM nonce/transaction lookup can establish the
charge while explicitly marking the service evidence unavailable. Unknown outcomes
remain reserved; neither a timeout nor a missing log releases them for replacement
spending.

Return of unused EVM funds is restricted to the original Ledger payer and requires
explicit operator review. Pending payments block it. An uncertain return cannot be
silently signed again. A zero-balance closure requires accounting that explains the
fully spent deposit; an unexplained empty wallet is not called a successful refund.
These return paths passed controlled tests, not a fresh live transfer in this pass.

The model adapter now retries a truncated generation once with a larger bounded
output allowance, records both attempts, and never executes truncated tool JSON.
Specialist reports with the required structured evidence are rendered from observed
fields. Causes, true economic values and candidate capabilities absent from the
sources remain unknown. Generic custom-agent prose is model interpretation, not a
guarantee of independently verified facts.

## Remaining acceptance gates

The **second specialist's paid workflow, custom-agent paid workflow, latest cold
restart/retry path, Ledger allowance increase and unused-funds return** still need
live acceptance checks.
Automated new paid runs and the isolated-stack restart were blocked during this
pass. They were not bypassed or represented as successes.

The current running preview has its earlier in-memory backend. The latest source is
on disk and has passed the controlled checks above. Restart only the isolated agent
stack after confirming that no device review, funding, return or investigation is
in flight. Do not kill unrelated Node processes or disturb Tailscale or the older
workspace.

Agent0's inspected candidate sample has incomplete capabilities, service URLs and
validation coverage. The selection specialist can legitimately conclude that there
is insufficient evidence to hire. The protocol source contains extreme indexed USD
valuations; the report flags them rather than treating them as real reserves or
asserting an unproven pricing-feed diagnosis. Testnet web-search and news providers
are not configured and are not exposed as working tools.

The services are local. No public cloud deployment, all-sponsor eligibility approval,
production security certification or winning claim was made. Mainnet money movement
remains outside the deployed agent path.

## Reproducible entry points

See [Agent workspace](AGENT-WORKSPACE.md) for prerequisites, trust boundaries and
operation. `agents:prepare` and `agents:boot` do not fund or execute an agent.
`agents:verify-live` reads existing chain evidence only. `agents:recover-report`
never calls a paid tool; it either formats retained specialist fields or uses
separately billed Vertex inference with no execution tools.

The reference orchestrator was inspected at
`b1d5dc4709237a7a64474f7b3320ac163dcd2b59`; this work extends Mandate's earlier
`bedd1dfc3bf14e9bd71280d9a836ac6672964f3f` skeleton. The reusable reporting/product
patterns were adapted, not its unrestricted wallet or plan-once execution paths.
Record prior work and the event-period delta truthfully for any submission.
