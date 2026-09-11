# Audit acceptance and live verification

Baseline: `f5ed2be`. Remediation branch: `repair/audit-2026-09-11`.
This is the acceptance record for the supplied ten-issue audit, not a broader
claim that every historical experiment or all upstream dependencies are production
ready. The goal is unchanged: a real useful task, one truthful Ledger authorization
boundary, bounded paid execution, and a connected interface with reconciled evidence.

## Observed end-to-end result

The live run on 11 September 2026 used **Base Sepolia testnet only** for payments:

| Item | Observed amount / result |
| --- | --- |
| New reviewed and Ledger-funded envelope | 0.10 USDC |
| Maximum per call | 0.01 USDC |
| Rolling one-hour limit | 0.03 USDC |
| Successful real paid calls | Three, 0.01 USDC each |
| Fourth real workspace request | Blocked by the rolling budget; no additional charge |
| Merchant revenue | 0.03 USDC, independently reconciled after claim/sweep |
| Remaining funds returned to payer | 0.07 USDC, exact transaction/calldata/transfer/balance proof |
| End state | Refunded, reserved liability zero, agent capability revoked |
| New Ledger funding signatures | One |

The public proof is [verification/live-proof-2026-09-11.json](verification/live-proof-2026-09-11.json).
It includes actual source data, channel/transaction identities, signing report,
container isolation, restart behavior and consensus readback. Earlier failed
operations are retained and linked to subsequent verified recovery; they are not
replaced with success-shaped results.

## Post-audit fully-spent lifecycle acceptance

A second fresh live cycle closed the remaining product gaps with the smallest
practical testnet amount:

| Item | Observed amount / result |
| --- | --- |
| Fresh reviewed and Ledger-funded envelope | 0.01 USDC |
| Useful paid work | One exact source-bound Agent0 due-diligence brief |
| Attempted additional run | Blocked by lifetime authority; zero additional charge |
| Merchant claim and settlement | Both transactions successful; receiver increased exactly 0.01 USDC |
| Fully-spent end state | `closed`, spent 0.01, reserved zero, refundable zero |
| Refund behavior | No refund task and no fabricated zero-value transaction |
| Repeat use | New salt/storage, source-bound, unfunded; old tasks retained in a separate read-only archive |
| New Ledger funding signatures | One; recorded `clear-basic` |

The public proof is
[verification/ledger-paid-lifecycle-2026-09-11.json](verification/ledger-paid-lifecycle-2026-09-11.json),
with a readable account in [LIVE-LEDGER-CYCLE-2026-09-11.md](LIVE-LEDGER-CYCLE-2026-09-11.md).
The frontend now also disables Run before creating a request when lifetime authority
is exhausted; the backend denial remains the authoritative financial guard. Prior
Mandate tasks are exposed as result-free archive summaries and only load full detail
after an authenticated operator inspection, without entering current accounting.

## Audit item mapping

| Original issue | Implemented remedy | Test evidence and live acceptance |
| --- | --- | --- |
| 1. Mandate promise exceeded enforcement | One `mandate.ts` execution path; pinned `scope.ts`; durable identity/channel binding; testnet-only signing; no silent top-ups | Scope/config/testnet/closed-state regressions. Actual fourth paid request blocked in the same live broker. Contract constraints and broker-only rules explicitly distinguished. |
| 2. Static console could not perform workflow | Authenticated `operator.ts`, real SQLite tasks, live query results, verified funding/settlement/refund stages | Real Chrome login/config/refresh/stop/mobile/keyboard tests; final funded-work-refund flow operated through the interface. No network-intercepted fake balances or approvals. |
| 3. Presence confused with authorization | Canonical expected-principal signature checks; action-bound one-time nonce and expiry; presence kept separate | Real cryptographic rejection tests for zero, wrong signer, altered/stale payload and replay. Actual funding signature verified against the Ledger payer. Custom approval type is not claimed to have deployed ERC-7730 labels. |
| 4. Budget unsafe under concurrency/restart | SQLite transactional integer reservations by mandate/network/asset, persistent signed liability, idempotent responses and reusable-client accounting | Twelve separate OS processes compete for one cap without overspend. Repeated-client, restart, unknown outcome and integer tests. Live .03 cap blocks call four; no double charging on recorded retries. |
| 5. Incomplete payment lifecycle | Prepare actual data before payment; persist merchant response/headers; explicit claim/sweep manager; independent receiver and refund reconciliation | Handler-failure tests. Live claim then sweep failure exposed and repaired; actual merchant balance increased .03. Actual .07 refund recovered after a transient receipt-read failure, with no second refund transaction. |
| 6. No demonstrated agent/broker boundary | Consumer in non-root, read-only, network-none Docker container; scoped host relay; no credential or Docker-socket mounts; closed/stop guards; session-only resume | Real container inspection/probes and paid consumer call. Real post-stop capability rejection. Fresh-process paid resume with `--no-addons` and zero new payer signatures. Physical USB disconnection / separate VPS provisioning is explicitly NOT claimed. |
| 7. Broken build and irreproducible verify | Actual type-contract repairs; lockfile install; deterministic checks separate from live/descriptor probes; CI definitions | Current native verification completed with exit 0: 181 deterministic checks, all four workspaces built. The earlier clean-Linux evidence remains a separately dated proof. Clean Linux installation/runtime verification has its own log and exit record; final report records its result rather than treating the Dockerfile as proof. |
| 8. Incomplete/unauthenticated evidence | Durable full events and hash chain, signed HCS anchors, receipt wait, readback-aware retries, independent publisher key validation | Signature/tamper/outbox tests. Real HCS submissions, retained failures, and 47 independently validated consensus records across workspace, buyer, and merchant journals; zero pending in the final proof. |
| 9. No task-to-result product | Real bounded query execution; deterministic isolated consumer produces a sourced registration comparison | Paid output includes actual query data, deployment, observation time and source block. The app does not claim an LLM fleet or general compute metering. |
| 10. Overstated reputation | Heterogeneous measurement values preserved as raw data; no unfiltered mean score granting spending rights; explicit user-reviewed receiver; bounded waits/cache freshness | Actual testnet source query, query-scope tests, nullable unselected fields and no fabricated trust rating. Registry/measurement counts are advisory, not identity uniqueness or authorization. |

## Verification commands and separation of evidence

`npm run verify` applies checked dependency guards, runs four malformed/valid image
parser tests, builds all four workspaces, runs their tests, and runs three resolver
tests. No wallet, live registry, private key or chain transaction is required.
The current observed count is 181: 4 parser guards + 5 facilitator + 161
gateway + 6 mandate-service + 2 service + 3 resolver tests. Test fixtures remain
isolated under tests/test-support; the audit itself permits test doubles and they
are never called live payment evidence.

`npm run test:ui` uses a real local HTTP app and persistence. It checks desktop and
mobile layouts, authentication, exact limit persistence, lost-response idempotency,
pre-submission exhausted-authority handling, stop across refresh, keyboard
focus/dialog dismissal, no page errors, and the automated WCAG A/AA scan.
`node scripts/live-visual-check.mjs` separately inspects the completed real run
without a financial operation. Both observed viewport scans had zero violations.
Automated checks are not a claim that every possible user/device combination has
been manually reviewed.

`npm run verify:linux` builds from source and the lockfile, then runs verification
inside a container with no runtime network, wallet credentials, host state or USB
device. The current clean-Linux run passed the same 181-check gate after a Docker build
from the committed source and lockfile. The verification container ran with no
runtime network, host credentials, host state or USB device. It remains a clean
installation/build/test proof, not the headless paid-broker proof.

`npm run verify:descriptors` invokes the official ERC-7730 linter. Full lint passed
for the current USDC and batch descriptors. Missing tooling is a failure; schema-only
validation is labeled separately. The financial funding trace was **clear-basic**.
A separate physical Ledger development proof used EthereumTest, a loopback Ledger
test-CAL bridge and CAL-test-key signatures to reach `calFilters=success` and
`verdict=erc7730` for Base Sepolia USDC typed data. This is labeled development
evidence, not production CAL/registry acceptance, and it broadcast nothing.

## Live failures repaired rather than concealed

A confirmed claim followed by `nothing_to_settle` exposed a combined lifecycle
recovery gap. Claims now persist before sweeping and a restart can sweep existing
claimed revenue without another voucher. An ambiguous broadcast is not blindly
retried. A real refund succeeded before RPC block reads were available; the original
multicall, amount, transfer and consistent snapshots now establish the refund and
update the UI. HCS `UNKNOWN` responses stay in the outbox and are reconciled before
retrying. Original errors remain in reconciled task detail.

## Explicit exclusions and residual risk

The project is **testnet-only**, not certified for mainnet or production custody.
It does not claim a physically unplugged Ledger run, separately provisioned VPS,
custom-action ERC-7730 display, general autonomous LLM fleet, unbiased reputation
oracle, narrated submission video, remote deployment, GitHub push, or hosted CI run.
Those are not silently inferred from tests, schemas or local evidence.

The old schema-1 config and old channels are preserved, not granted new authority or
reported as recovered. The .10-USDC proof uses a distinct reviewed envelope. Optional
extra rails, treasury, Substreams and registration experiments remain separate and
are not a requirement for this audit's narrowly scoped target flow.

Dependency scanning found and removed critical/moderate transitive issues. A guarded,
reproducible mitigation covers the remaining upstream image-parser loops; raw audit
labels remain visible. The low-severity upstream elliptic implementation warning
remains. See [DEPENDENCIES.md](DEPENDENCIES.md): there is no misleading “zero
vulnerabilities” or complete supply-chain-security claim.

No Tailscale settings, routes or processes were changed. Temporary preview access
is restricted to screenshot files, never the operator control plane or credentials.
