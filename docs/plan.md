# Build plan

Submissions close **Sunday 13 September 2026, 12:00 pm EDT**. Late entries are
not accepted. Everything below is sized against that, not against ambition.

Full reasoning and prize-requirement mapping: see the build spec artifact.

## Load-bearing minimum

If everything else is cut, these four still constitute a submission:

1. Sign a mandate on the device — Clear Signed, budget and scope legible
2. Run many paid queries inside it with **zero** device interactions
3. One escalation that stops the agent until the device is tapped
4. The evidence timeline, reconstructed from HCS

## Cut order

Bottom up, without hesitation:
Proof of Human → Harness PR → Substreams → discovery resolver →
batch settlement on Hedera (fall back to Base).

## Before writing any code — accounts and funds

None of this is coding, all of it blocks Day 1. ~40 minutes total.

| # | What | Where | Notes |
|---|---|---|---|
| 1 | **Graph Studio API key** | thegraph.com/studio → API Keys → Create | **Hard dependency (F7).** No public route to Agent0. Seal it: `printf '%s' "$KEY" \| wallet-cli ring encrypt --key graph-gateway > secrets/graph.enc` then unset it |
| 2 | **Hedera testnet account + HBAR** | portal.hedera.com | Choose **ECDSA** keys (EVM-compatible, works with the Hiero relay). 1,000 test HBAR/24h |
| 3 | **Base Sepolia ETH** | Alchemy or Superchain faucet | 0.1 ETH/24h. Gas for the escrow channel |
| 4 | **Base Sepolia USDC** | faucet.circle.com | The mandate budget itself. 10–20 USDC per drip |
| 5 | **Start the ETHGlobal submission** | Hacker Dashboard | Claims the slot and lets you save drafts. Do not leave it to Sunday |

## Demo video rules — read before scripting

From the official ETHOnline 2026 rules. Two of these disqualify work:

- 2–4 minutes, **720p minimum**
- **No AI voiceover or text-to-speech** — you narrate it yourself
- No mobile phone recordings
- No artificial speed-up to fit the time limit
- Clear audio, no background noise
- Max 4 bullet points per slide

## Write the demo script BEFORE building

A judge decides in ninety seconds. The script determines what actually has to
exist, so writing it first is the cheapest scope control available — anything
the script does not show is a candidate to cut.

Running order that matches the product's logic:

1. **The arithmetic problem** (~20s) — hardware approval is per-transaction,
   agents act thousands of times per hour. That mismatch is why hot keys sit in
   env vars.
2. **One device tap** (~25s) — sign the mandate. Show the Clear Signing screen.
3. **400 queries fly past** (~30s) — no device interaction, budget meter
   climbing. This is the "oh" moment.
4. **Escalation** (~40s) — agent hits an unrated counterparty, stops. Device in
   frame. Approve. It resumes.
5. **Evidence** (~25s) — the HCS timeline, consensus timestamps.
6. **The unplug** (~20s) — pull the Ledger, show it still working headless.
   Nobody else will show this, and it is proven (F11).

## Day 1 — Tue 8 Sep — de-risk

- [x] Confirm Blocky402 testnet advertises `hedera:testnet` (done, feePayer `0.0.7162784`)
- [x] Facilitators, chains, packages, gateway wire formats — all verified
      (`docs/FINDINGS.md`, `npm run preflight`: 8 passed, 0 failed)
- [x] Open a batch-settlement channel on Base Sepolia via the self-hosted facilitator
      (testnet, free — `npm run check:mandate` then `npm run mandate:open` once funded;
      the Day-1 plaintext-key spike is deleted, superseded by the mandate flow)
- [x] Graph Studio API key, sealed into the Key Ring — hard dependency (F7)
      (`secrets/graph.enc`; rotate in Studio before public demo — key was in chat export)
- [ ] 30 min spike on the `upto` scheme — may map to a mandate even more directly
- [x] `npm i -g @ledgerhq/wallet-cli`
- [x] `wallet-cli ring init` with the device attached
- [x] Prove headless `ring decrypt` works with the device unplugged (`npm run preflight`)
- [x] **Settle finding F6**: raw plaintext from `ring decrypt` (no envelope)
- [x] `npx skills add ledgerhq/agent-skills` (4 skills, project-level: `.agents/skills/` + `skills-lock.json`)
- [x] Settle one throwaway x402 payment end to end
      (`npm run live:gates` runs all gates; or `npm run check:ready` then `npm run e2e:payment`)

Stop rule: if Key Ring or settlement is still broken at end of day, post in
the Ledger ETHGlobal Telegram before sleeping.

## Day 2 — Wed 9 Sep — the spine

- [x] Sealed Hedera signer delegating to `@x402/hedera` ExactHederaScheme (stock client + `wrapFetchWithPayment`; judgment in SDK hooks)
- [x] Proxy request path: intercept 402 → decide → settle → retry (`GET /proxy`)
- [x] `audit.submit` to an HCS topic (requires `MANDATE_HCS_TOPIC_ID`; `npm run provision:hcs` then `npm run e2e:audit`)
- [x] Stand up `packages/service` — verify + settle before serving

## Day 3 — Thu 10 Sep — judgment and consent

- [x] Re-resolve Agent0 subgraph IDs against Graph Explorer (they move)
      (`npm run probe:reputation` — 6/9 subgraphs reachable, `REPUTATION_OK`)
- [x] Wire Subgraph MCP; end-to-end reputation lookup
      (Graph Studio key + `lookupCounterparty` in proxy path; MCP optional per plan)
- [x] `stepup.requireDeviceApproval` against DMK
      (live `STEPUP_OK` — `.live-results/stepup-live-clear.txt`, mode=clear)
- [x] ERC-7730 descriptor draft + EIP-712 typed payload
      (`docs/erc7730-mandate-stepup.json`, `buildStepUpTypedData`; registry PR post-hackathon)

## Day 4 — Fri 11 Sep — extras, then freeze

- [x] ~~Substreams `x402-payments` module~~ — CUT, not deferred (F24: no Base Sepolia endpoint on either provider, and no toolchain obtainable to build it — a module that can neither compile here nor observe our chain is theater)
- [x] Scheduled-Transaction treasury top-up leg (HIP-423 wait-for-expiry; `treasury:topup`; live run pending operator)
- [x] HCS-14 UAID registration (`uaid.ts` + `npm run uaid:register`; every audit record carries the operator UAID — live inscription pending operator run)
- [ ] Hedera Harness Tier 3.5 x402 assertion PR — **only if the core is stable**
- [ ] Deploy the gateway to a VPS; the no-device demo runs from there
- [ ] Record a clean step-up take as insurance

## Day 5 — Sat 12 Sep — the submission is the product

- [ ] 2–4 min video: one allow, one step-up with the device in frame, one deny
- [ ] Screen-record a real settled transaction ID
- [ ] Finish `DX.md`
- [ ] README with one-command reproduction
- [ ] **Submit Saturday evening, not Sunday morning**

## The console

Day 4, timeboxed to one day. Four screens, real data, no settings pages, no auth:
fleet · mandate · approvals · evidence. UI is where hackathon time goes to die,
but a product without a face is plumbing — see `docs/sponsor-case.md`.
