# Autonomous agent workspace

Implementation state: 12 September 2026. This is the **new exact-payment agent
workspace**, not a renaming of the older single-query batch-channel demonstration.
The current acceptance record is [agent product progress](agent-product-progress.md).

## The product

Mandate delegates a complete investigation while retaining a human-reviewed
spending boundary. Its two specialists and custom agents use the same adaptive
runtime:

**Goal -> next useful action -> strict tool input -> reviewed x402 quote -> durable
budget reservation -> signed payment -> verified receipt and evidence -> next action
or an honest conclusion.**

The Protocol Investigator examines a configured protocol's activity, evidence
quality and relevant market context. The Agent Selection Analyst examines actual
Agent0 registrations, declared capabilities and feedback coverage. A custom agent
saves a user's goal, instructions, expected result, permitted tools and stopping
limits. Editing a saved definition cannot change an existing run's snapshot.

A specialist cannot be marked complete solely because the model says "done": it
must cite successful observations from at least two different configured tools,
including its required Graph source. The system does not force redundant purchases
just to increase a tool-call count. Missing services or inadequate candidate
metadata can produce a useful partial investigation instead of a fabricated result.

## Actual services in the current prepared configuration

| Tool | Useful output | Payment network | Price per accepted request |
| --- | --- | --- | --- |
| `graph-protocol` | Fixed, schema-verified protocol snapshots from The Graph | Base Sepolia | 0.001 test USDC |
| `graph-agent0` | Indexed candidate registrations and bounded feedback evidence | Base Sepolia | 0.001 test USDC |
| `crypto-prices` | Fresh Coinbase public spot observations for BTC, ETH or SOL | Base Sepolia | 0.001 test USDC |
| `hedera-analysis` | Reproducible protocol-quality or candidate-coverage investigation using fresh Graph reads | Native Hedera testnet | 0.002 test USDC |

These are **Mandate-operated x402 services**. The upstream public APIs are data
providers, not fictitious testnet x402 vendors. In particular, Coinbase does not
receive the testnet payment. The Graph is queried through its actual gateway using
a sealed provider credential; its results materially change the investigation.
The native Hedera service uses the stock exact scheme and Blocky402 settlement.
It is not merely an HCS anchor of a Base payment.

All four endpoints produced real HTTP 402 challenges. The subsequently observed
Protocol Investigator run also completed five real paid responses across both
networks: three protocol queries, one Evidence Lab analysis and one market-data
request. These charges were independently checked on chain. The Agent0 discovery
endpoint has been queried as a live provider and advertised a real challenge, but
its paid path has not yet been exercised in this pass.
No working testnet web-search or news provider is currently configured. Those tools
are absent from the runtime catalog and disabled in the custom-agent editor.

Read-only protocol data can come from a mainnet subgraph while all money movement
remains on testnets. Those facts are displayed separately. The application does
not trade assets, hire arbitrary remote agents or execute uploaded agent code.

## Authority, custody and accounting

The prepared allowance starts with 0.25 test USDC, a 0.02 per-call cap,
0.10-per-hour rolling cap and a 24-hour expiry. The operator may later choose
**Increase allowance** and approve an additional Base Sepolia test-USDC transfer on
Ledger. A confirmed increase raises only the shared lifetime ceiling (hard-capped at
5 test USDC); tools, recipients, per-call limit, rolling limit and expiry stay
unchanged. Agents cannot request or approve an increase themselves. Each run keeps
its own lower or equal spending envelope and bounded duration/decision count.

Ledger authorizes a **specific Base Sepolia USDC transfer to a new software spending
wallet**. The funding signature is recovered against the expected Ledger payer,
and an independently checked chain receipt is required before paid runs are
available. Opening the app, preparing configuration, or opening the review dialog
does not sign or transfer anything.

The software spending key is encrypted with Ledger Key Ring. The trusted broker
unseals it only for a reviewed operation. Key Ring protects storage; it does not
turn a software signer into a hardware-held key or protect a fully compromised
operator host. The model receives constrained tool schemas and evidence, never
wallet keys, unrestricted payment access, or permission to enlarge its limits.

Native Hedera payments use the separately reviewed, existing Key Ring-protected
Hedera testnet account. The EVM and Hedera USDC assets have separate wallets,
recipients and transaction formats. They share an application-level spending
ceiling because both have six-decimal USDC accounting. **There is no bridge, pooled
cross-chain wallet balance or single hardware-enforced cross-chain cap.** The
Hedera account may hold more than the approved allowance; its detailed spending
policy depends on the trusted broker.

The UI distinguishes confirmed payments, reserved/uncertain amounts, and remaining
spending authority. Remaining authority is not a wallet balance. Vertex inference
is billed by Google Cloud separately; the run retains model names and reported token
usage without pretending to infer a dollar bill from token counts.

## Local setup and launch

Use the pinned lockfile and the repository's supported Node version. The current
Mac checks ran on Node 26.7.0. First-time setup needs the existing Ledger Key Ring
provisioning, OS-keychain unlock, sealed Graph credential, sealed Hedera key and the
sealed facilitator/authorizer keys used by the repository's testnet stack.

Required existing ciphertext includes `secrets/graph.enc`, `secrets/hedera.enc`,
`secrets/mandate-facilitator.enc` and `secrets/mandate-authorizer.enc`. Do not print
or copy their plaintext. A dedicated EVM agent wallet is generated and sealed by
preparation; it does not reuse the Ledger private key.

Google Cloud must already be authenticated on the broker host, with Vertex access
and billing authorized. Preparation verifies a real response from the configured
model. It defaults to `gemini-3.5-flash`; `MANDATE_VERTEX_MODEL` and
`GOOGLE_CLOUD_PROJECT` can select reviewed alternatives before preparation.
This is a configured and live-tested model, not a claim that it is always the
latest or cheapest available model.

Supply public identities through `MANDATE_LEDGER_PAYER`, `MANDATE_AGENT_RECEIVER`,
`MANDATE_HEDERA_ACCOUNT_ID` and `SERVICE_PAY_TO`. Existing local operator settings
can supply these values on the already-provisioned Mac. The Hedera payer and service
recipient must be distinct, associated with testnet USDC, and have sufficient test
balances. The Base Sepolia facilitator needs test ETH for settlement gas.

```sh
npm ci
npm run agents:prepare
npm run agents:boot
# In a second terminal:
npm run agents:open
```

Preparation discovers sources through the real Graph MCP and queries each selected
schema before accepting it. It rejects unavailable deployments rather than silently
querying a different source after authorization. It checks native token associations
and the live Blocky402 fee-payer account, and pins the exact tool configuration hash.
It writes an **unfunded** immutable authority under `state/agents/operator`.
An existing configuration is reported, never silently overwritten or topped up.

The isolated stack binds only to loopback:

| Component | Port |
| --- | --- |
| Agent operator / workspace | 8420 |
| Native Hedera Evidence Lab | 8423 |
| Base Sepolia paid services | 8425 |
| Testnet facilitator | 8426 |

The previous stack on 8410/8405/8406 is left alone, as are Tailscale and unrelated
tunnels. `npm run agents:open` creates the normal local operator session without
printing its access token. Do not tunnel an authenticated operator interface or
copy a token into a public URL. The current agent services are **local**, not a
public competition deployment.

## Human funding and the investigation

Open **Spending & limits -> Review Ledger funding**. Inspect the exact asset,
amount, software-wallet recipient, shared limits, expiry, Hedera account and trust
boundary. Explicitly confirm the review, then read the actual transfer on the
physical Ledger. Reject a mismatch. UI confirmation is not a substitute for the
hardware signature or a chain receipt.

After verified funding, **Spending & limits -> Increase allowance** lets the operator
enter an additional amount, review both the current and resulting ceilings, and
approve exactly that new transfer on Ledger. The new authority is usable only after
its chain receipt is verified. An ambiguous increase is reconciled from the retained
authorization; no second Ledger signature is created.

After verified funding, **Run task** offers the specialists and custom-agent form.
A run shows the current purpose, selected service, quote, payments and findings.
A completed or partial result has readable sections, retained sources, separate
Base/Hedera receipts, technical evidence and an authenticated Markdown export.
Refresh retains the selected investigation. A lost submission response preserves
its original request ID instead of issuing another run automatically.

Stop cancels new work and persists across a restart. It does not reverse an already
submitted payment. The operator processes one investigation at a time against this
shared allowance, and blocks new work while an outcome is uncertain.

## Recovery and unused funds

**Funding:** a rejected, unexported signature attempt can be retried after review.
An exported authorization with a lost response is observed through its retained
transaction or authorization nonce. It is not signed again automatically.

**Service payment:** select **Check existing receipt**. The broker first retrieves
the original completed response using a read-only first-party lookup. That lookup
cannot invoke the service provider or settlement. It independently verifies the
chain transfer before accounting for it.

If the merchant cache was lost, native payments are located by their retained
signed transaction ID. New EVM payments retain a pre-signing block checkpoint and
`AuthorizationUsed` nonce lookup. Older retained requests may require an explicit
transaction hint when their merchant response is unavailable. A bounded log search can fail to locate a result;
that never releases a reservation as though the payment were impossible. The
operator-only reconciliation API also accepts an existing transaction hint and
still verifies its token transfer, payer, recipient and authorization.

A chain-confirmed payment with no surviving service result is explicitly marked
**paid, evidence unavailable**. It is not reported as successful research. A
recovered receipt does not automatically restart the model or reclassify a partial
run as complete. Unconfirmed outcomes remain reserved for manual investigation.

**Return unused funds:** finish or stop the current run and reconcile every pending
payment. Select **Return unused funds**, review the current Base Sepolia token
balance and original Ledger payer, then explicitly confirm. The broker can return
only the displayed amount to that original payer, and closes the allowance only
once the transfer is verified. A lost return response is reconciled, never silently
repeated. A zero wallet balance closes without a transfer only when confirmed
charges fully explain it; an unexplained empty wallet is an error, not success.
The existing Hedera wallet is separate and is not swept by this action.

The lifetime of the software keys extends past allowance expiry for safe recovery.
Do not delete `state/agents`, the journals, ciphertext or Key Ring membership while
funds or unresolved transactions remain. An expired/stopped authority cannot pay
for new work but can still expose its retained history and recovery actions.

## Verification and evidence boundaries

```sh
npm run verify
npm run test:ui
npm run test:agents:ui
# Requires the prepared, running local stack; creates no paid run:
npm run test:agents:workspace
```

`test:agents:ui` runs an isolated temporary operator, genuine HTTP/SQLite/runtime and
SDK formats, but **simulated model and settlement**. Its reports and screenshots
are labeled as controlled fixtures. It verifies adaptive action selection, reports,
accounting, receipt links, inert model-authored HTML, reload and cancellation without
using live wallet keys or making cloud/chain requests.

`test:agents:workspace` inspects the actual prepared local configuration, checks
responsive navigation and accessibility, and saves a custom agent through the real
API. It may open and dismiss the funding review; it never confirms it or starts paid
work. Opening a page is not evidence that funding or delivery succeeded.

Live source/model probes, setup metadata and screenshots are retained locally under
ignored `.live-results/agent-integration` and `state/agents`. Only sanitized summaries
belong in public docs. Check the acceptance record for exactly which checks passed.

## Read-only verification and report recovery

```sh
# Read retained authorizations and independently check existing chain receipts:
npm run agents:verify-live

# Produce a report from an existing incomplete run; never purchase another source:
npm run agents:recover-report -- EXISTING_RUN_ID
```

A retained specialist Evidence Lab result can be formatted deterministically with
no model inference. Generic report-only recovery can use Vertex and is billed
separately, but receives no callable tools or spending authority. Repeating normal
recovery after success is idempotent. An explicit `--review-claims` revises the report
with a preserved prior draft; `--require-observed-report` refuses to fall back to
billable model inference when the structured specialist fields are absent.

## Known limitations and submission gates

The inspected Agent0 candidate sample had many missing capability descriptions,
x402 declarations, service endpoints and validation records. Registry presence is
not proof of a hireable paid agent. The selection specialist must say so. It does
not run unapproved external candidate endpoints or manufacture sample evaluations.

The inspected Uniswap data contained extreme USD valuations. Evidence Lab flags
those values and excludes partial UTC-day buckets from trend comparison. Its checks
are transparent heuristics over indexed data, not an independent price oracle or a
trust score. Separate Graph queries are not an atomic multi-query snapshot.

A Ledger funding of 0.25 test USDC and five real paid responses
(total 0.006 test USDC) have been independently verified for the Protocol
Investigator. The original final generation reached MAX_TOKENS. Its evidence was
retained, report-only recovery succeeded without new x402 calls, and a final factual
summary was rebuilt from observed specialist fields without another model call.
The audit trail still records the original partial execution.

The source now gives a truncated generation one bounded reasoning-only retry
(8192 then 16384 output tokens), records both usage attempts, and never executes a
truncated tool decision. Built-in specialists with the required Evidence Lab fields
render their findings directly from observed metrics and explicit quality gaps;
they do not promote a model's unproven diagnosis into the factual summary. Generic
custom-agent prose remains model interpretation rather than independent fact
verification.

Live acceptance is still needed for the second specialist, custom-agent paid
workflow, the latest cold-start/retry path and unused-funds return. Automated new
paid runs and the isolated-stack restart were blocked during this pass; no workaround
was used. The running preview therefore has the earlier in-memory backend, while
the latest implementation is on disk and exercised by the controlled test suite.
Do not interrupt an active device review or payment to restart it. The older
batch-channel Ledger proofs do not fill these remaining acceptance gaps. A public paid endpoint, submission video, exact sponsor
eligibility and a fresh hardware clear-signing assessment also require their own
verification. No winning, production-security, public-deployment or all-tracks-
qualified claim follows from passing local tests.

## Reuse and event-period work

The reference repository is `Satianurag/x402-agentic-orchestrator`, inspected at
commit `b1d5dc4709237a7a64474f7b3320ac163dcd2b59` (23 July 2026). Its natural-language
job entry, progress/report separation and structured report design informed this
integration. `agent-report.ts` adapts that reporting pattern to durable Mandate
receipts rather than trusting model-authored spending totals.

Its plan-once execution and unrestricted wallet paths were not copied as a security
boundary. Mandate retains its own Key Ring custody adapters, authenticated operator,
transactional journal, strict tools, observation-driven runtime and chain verification.
The current work extends Mandate's previously committed agent skeleton
(`bedd1dfc3bf14e9bd71280d9a836ac6672964f3f`) with configured real providers, native
Hedera payments, explicit Ledger funding, return/reconciliation, report-first UX and
integration tests. Declare the prior work and event-period delta honestly; eligibility
is not inferred from repository ownership or a few recent commits.
