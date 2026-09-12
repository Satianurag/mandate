# Current agent workspace

## One application

`scripts/start.mjs` launches `packages/gateway/src/operator.ts` on loopback port 8410 with `state/mainnet/operator`. All product launch aliases resolve here. `/` and `/workspace` serve the same `console/workspace.html`; workspace.css is the single design stylesheet. The former landing assets, conditional batch layout, merchant frontends and separate 8420 launcher are retired. Existing historical state and encrypted credentials are preserved.

The former two-port behavior came from `stack.mjs` launching one operator against state/live on 8410 and `agent-stack.mjs` launching another against state/agents on 8420. Their different configuration enabled different layouts. Both launchers now delegate to the canonical entry point.

The design reference is the user-provided Buffer ZIP. No reference-project visual design was copied. Home provides summaries; New task contains agent selection; task detail contains progress and reports; Runs contains history; Ledger budget contains funding; Receipts contains payment evidence; Settings contains gcloud and connection configuration. Services has no sidebar or page; the agent selects tools within the Ledger-approved scope.

## Reference architecture mapping

Reference: Satianurag/x402-agentic-orchestrator, commit `b1d5dc4709237a7a64474f7b3320ac163dcd2b59`.

| Reference behavior | Mandate adaptation |
| --- | --- |
| plan.ts, estimate.ts, planner-guards.ts | agent-plan.ts validates bounded tool steps, probes unpaid offers, checks integer budgets and stores a short-lived review |
| run-controller.ts approval | operator.ts binds plan approval to agent version, goal and authority before launching |
| run.ts/tool-execution.ts | agent-runtime.ts executes approved steps then chooses useful next steps from retained observations within the approved run cap |
| paid-step checkpoints | SQLite events retain request identity, input hash, observed evidence and spending; resume does not replace unresolved payments |
| x402-client.ts | stock x402 exact EVM client with pinned Base mainnet USDC, recipients, endpoints and broker accounting |
| vendor-errors.ts | adapted provider failure classification without promising unsafe payment retries |
| final synthesis and follow-up | Vertex report generation and saved-evidence follow-up without invoking paid tools |

Mandate retains its trusted broker and Key Ring instead of the reference software-wallet provisioning. Its reviewed HTTP catalog replaces dynamic MCP discovery. A transport failure after signing never triggers an automatic alternate paid vendor request. The broker reconciles nonce/chain evidence; only explicitly supported first-party response recovery may resend the identical authorization. Model usage is separate from USDC tool spending.

## Ledger and payment boundary

Setup drafts hold public configuration. Preparing authority checks chain 8453, exact v2 USDC offers and facilitator support, seals a newly generated spending key using an existing Ledger Key Ring key, verifies the seal round trip and writes the runtime configuration atomically. Hardware address reading requires device confirmation. Preparation and startup do not fund the wallet.

Funding and allowance increases require explicit UI review and Ledger approval. Production Ledger context is used; test CAL configuration is rejected. Settlement checks wait for chain receipts and verify the expected USDC transfer and authorization nonce. Unknown outcomes remain pending instead of being reported successful. Limits, recipient and path checks remain outside model control.

## Acceptance boundary

Mainnet-only refers to the active application's signing and settlement boundary. Historical testnet artifacts are archival evidence, not active configuration or proof of current behavior. The user's real address and live payment authorization are deferred. Do not represent hardware approval, external vendor settlement, production credentials or the entire final flow as verified until that run occurs. Test writing and execution were paused at the user's request during final implementation.

## Gemini configuration

The active default is `gemini-3.5-flash` on the global Vertex endpoint, using `gcloud auth print-access-token` and the configured project as the quota project. Planning and execution both use HIGH thinking, a 65,536-token output ceiling, and expanded retained evidence context. Context7 model/thinking documentation and gcloud Model Garden both confirmed the model ID. No fallback model is substituted when access fails.
