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
- [ ] Open a batch-settlement channel on Base Sepolia via `x402.org/facilitator`
      (testnet, free, no contract deployment of ours)
- [ ] Graph Studio API key, sealed into the Key Ring — hard dependency (F7)
- [ ] 30 min spike on the `upto` scheme — may map to a mandate even more directly
- [ ] `npm i -g @ledgerhq/wallet-cli`
- [ ] `wallet-cli ring init` with the device attached
- [ ] Prove headless `ring decrypt` works with the device unplugged (`npm run preflight`)
- [ ] **Settle finding F6**: does `ring decrypt` return raw plaintext or a JSON
      envelope over a pipe? This is the sharpest remaining unknown — preflight
      checks it automatically once a device is attached.
- [ ] `npx skills add ledgerhq/agent-skills`
- [ ] Settle one throwaway x402 payment end to end

Stop rule: if Key Ring or settlement is still broken at end of day, post in
the Ledger ETHGlobal Telegram before sleeping.

## Day 2 — Wed 9 Sep — the spine

- [ ] `hedera.buildAndSign` against `@hiero-ledger/sdk`
- [ ] Proxy request path: intercept 402 → decide → settle → retry with `X-PAYMENT`
- [ ] `audit.submit` to an HCS topic
- [ ] Stand up `packages/service` — the paid counterpart

## Day 3 — Thu 10 Sep — judgment and consent

- [ ] Re-resolve Agent0 subgraph IDs against Graph Explorer (they move)
- [ ] Wire Subgraph MCP; end-to-end reputation lookup
- [ ] `stepup.requireDeviceApproval` against DMK
- [ ] ERC-7730 descriptor so the device shows recipient and amount in words

## Day 4 — Fri 11 Sep — extras, then freeze

- [ ] Substreams `x402-payments` module
- [ ] Scheduled-Transaction treasury top-up leg
- [ ] HCS-14 UAID registration
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
