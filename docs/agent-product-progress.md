# Autonomous x402 agents — implementation record

Approved scope: two goal-completing templates (Protocol Investigator and Agent
Selection Analyst), prompt-created custom agents, adaptive Vertex reasoning,
multiple useful x402 tools, Ledger-approved bounded spending, live Graph evidence,
useful Hedera x402 service, durable history/receipts and honest failure handling.
The existing single-query flow is not completion of this scope.

Mainnet experiment allowance: at most $5 total, including transaction costs from
that allowance. No automatic increases. No mainnet expenditure in this work yet.

User steering: complete the real testnet flow first, then move to mainnet. The
mainnet funding request is deferred. Do not treat absent mainnet funds as a
testnet blocker. Public vendors observed so far offered mainnet; testnet work
must use explicitly identified real x402 services and actual testnet receipts,
not pretend those vendors accept test tokens. The endpoint/provider distinction
must remain clear in the UI and evidence.

## Verified starting state

- Existing workspace broker is Base Sepolia, single-receiver batch settlement.
- Existing isolated consumer submits a fixed research task; no adaptive model loop.
- Older orchestrator plans once and executes a sequence. Reuse needs adaptation.
- Unpaid live probes returned x402 offers from Graph, Exa, Otto, APIToll and
  OneSource. OneSource offered exact and batch settlement. These probes do not
  establish paid delivery or data quality.
- Existing scope/journal suite: 17 passed before implementation.
- Graph testnet gateway and Blocky402 testnet support responded; local native
  Hedera service port 8403 was not listening at that observation.

## Completion gates (all remain open until directly verified)

- Two saved templates plus custom-agent creation/editing in Run task.
- Goal -> multiple paid x402 services -> observation-driven next action -> result.
- Vertex integration verified with the configured project/model; usage distinct
  from x402 spending. No credentials exposed to the model or browser.
- Protected exact signer and Ledger funding authority verified before mainnet use.
- Durable spending reservations, uncertain outcome reconciliation, stop/restart,
  immutable per-run authority and no silent increase in permissions.
- Useful live Graph and Hedera x402 outputs materially contribute to a result.
- Source-linked result, receipts, history, partial results and failure UX.
- Live small paid experiments, adversarial recovery tests and browser verification.
- Reused code attribution, event-period change documentation and runnable demo.

This file records evidence and outstanding work; it is not a completion claim.

## Implementation evidence — first working slice

- Added persistent custom profiles, immutable run snapshots, idempotent run
  submission, progress events, stop and interrupted-run preservation.
- Added adaptive model/tool/observation loop; controlled tests prove a second
  action depends on the first observation, and unknown payments prevent retries.
- Added Vertex adapter. Live gcloud project catalog access succeeded after
  supplying the quota-project header. A tiny `gemini-2.5-flash` inference returned
  HTTP 200 and valid JSON (48 total tokens). This is model access proof, not an
  end-to-end agent run.
- Added exact x402 adapter with fixed endpoint mapping, approved recipients,
  durable shared/per-run reservations and USDC transfer+nonce chain verification.
  Four controlled tests pass; live paid settlement remains unverified.
- Browser test passes custom creation/edit/reload, desktop/mobile layouts,
  accessibility and existing workspace recovery flows. Screenshots are under
  `.live-results/repair/browser/agents-{desktop,mobile}.png`.
- Production agent services are not yet configured/wired. The UI explicitly
  disables execution until those services and spending authority are ready.
- Still outstanding: full production setup/funding/recovery UX, real paid
  multi-tool output, protocol source coverage, useful Hedera integration, end-to-end
  verification and submission documentation. Mainnet expenditure remains zero.
- Full gateway regression suite passed 174 tests before the subsequent production
  loader/readiness refinements; rerun after the next implementation slice.
- Physical Ledger read-only probe matched saved payer
  `0x57a2a47Ca22AE52867c5313c4d9ab43070D7C202`. Live Base mainnet balance read:
  0 USDC, 0 ETH. No signature requested, no funds moved. User was asked to fund
  the verified account within the existing $5 allowance; this is a paid-test
  prerequisite, not a reason to stop independent implementation.
