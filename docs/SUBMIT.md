# Operator leftover (Phase 5) — no UI

These cannot be finished by the agent alone. Each item has a command or a
paste-ready draft. Do them in this order before Sunday 13 Sep 2026, 12:00 pm EDT.

## 1. Rotate the Graph Studio API key

The key in the 9 Sep chat export is burned. In Subgraph Studio → API Keys:

1. Create a new key.
2. Seal it (never leave it in the shell history):

```bash
printf '%s' "$NEW_KEY" | wallet-cli ring encrypt --key graph-gateway > secrets/graph.enc
unset NEW_KEY
npm run probe:reputation
```

3. Delete the old Studio key.

## 2. VPS headless gateway (F11)

On the VPS (no Ledger attached):

```bash
# copy secrets/*.enc, mandate.yaml, and this repo
export WALLET_PASS=$(# from your password manager — not disk)
npm ci
npm run verify
npm run boot                 # paid service + gateway; Key Ring unseals in-process
# or: npm run boot -- --smoke
```

Key Ring decrypt works with the device unplugged (F11). Do **not** copy
`X402_PRIVATE_KEY` or a plaintext `.env`.

## 3. Video (2–4 min, you narrate — no AI VO)

Beats from `docs/plan.md`:

1. Arithmetic problem (~20s)
2. One Ledger tap — mandate open (~25s). Honest: structured EIP-712 on device
   (`clear-basic`, F32). Do **not** say labeled ERC-7730 fields unless
   `npm run e2e:erc7730-device` printed `ERC7730_DEVICE_CLEAR`.
3. Paid queries with zero extra taps (~30s). Paid JSON is live Agent0, not a demo row.
4. Escalation + device in frame (~40s)
5. HCS evidence (~25s)
6. Unplug the Ledger; headless still works (~20s)

## 4. ETHGlobal draft

Paste into the Hacker Dashboard:

**Name:** Mandate

**Description:** A hardware-signed authorization envelope for x402 agents.
Approve a budget once on a Ledger; the agent pays at machine speed inside
bounds it cannot widen. Reputation from Agent0 (The Graph / Subgraph MCP),
settlement on Base Sepolia batch-settlement + Hedera exact, evidence on HCS.

**Source:** https://github.com/Satianurag/mandate

**Demo:** (video URL after recording)

**Sponsors:** Ledger, The Graph, Hedera

## Already filed (do not re-open)

- Hedera Harness Tier 3.5: https://github.com/hedera-dev/hedera-harness/pull/54
- ERC-7730 registry: https://github.com/ethereum/clear-signing-erc7730-registry/pull/2972
  (Voucher/Refund descriptors; pending ingest. Mandate-open tap is USDC EIP-3009
  BASIC EIP-712 until CAL filters load — do not claim labeled Clear Signing).
