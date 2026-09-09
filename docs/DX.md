# Mandate DX — the developer journey per sponsor

This is the sponsor-facing companion to the README: for each sponsor, what a
developer *does* with Mandate, command by command. Every command below exists
in `package.json` and is the same command the operator runs — there is no
separate demo path. Anything that needs hardware or testnet funds is marked;
everything else runs anywhere via `npm run verify`.

Trust anchor: `npm run verify` reproduces every checkable claim with an empty
environment. Start there; believe nothing else first.

## Ledger — approve a mandate, not transactions

1. Describe the envelope in `mandate.yaml` (budget, scope, expiry,
   escalation rules — see the README for the annotated fields).
2. `npm run mandate:keygen && npm run facilitator:keygen` — fresh
   payer/submitter keys, never reused across demos.
3. Fund the payer with Base Sepolia USDC and the submitter with ETH (the
   scripts print the funding links).
4. `npm run check:mandate && npm run mandate:open` — **one device tap**
   opens the on-chain escrow channel. The tap Clear-signs the channel open
   (`docs/erc7730-mandate-stepup.json` carries the v2 descriptors, so the
   device screen shows the mandate fields, not hex).
5. The agent now pays per request with off-chain vouchers, each capped by
   the mandate. Breach the envelope and the device is consulted again
   (`npm run e2e:stepup`, proven live — see `docs/STEPUP.md`).
6. `npm run mandate:refund` — unspent budget returns through the channel's
   refund path. Revocation is a transaction, not a support ticket.

What the developer never touches: a plaintext private key (Key Ring only,
`npm run seal:keys`), per-transaction approvals, or the escrow math — the
stock `batch-settlement` scheme owns the vouchers.

## The Graph — pay per query, scored per counterparty

1. `npm run seal:keys` — the Graph Studio API key is sealed into the Key
   Ring once; it never appears in env or chat again.
2. `npm run probe:reputation` — live Agent0 reputation for any payee,
   including Hedera `0.0.x` accounts (resolved via their EVM alias, F20).
3. Every payment is policy-judged before creation: allow, step-up (device
   tap), or deny — the F18 weighted hybrid with hard gates. Deny reasons
   cite the mandate line that fired.
4. Query volume is what the mandate envelope is *for*: hundreds of sub-cent
   queries inside one hardware-approved budget.

What the developer gets: the pay-per-query gateway with the missing piece —
an authorization story that survives contact with a finance team.

## Hedera — evidence, identity, and a payer that never strands

1. `npm run provision:hcs` — the audit topic. Every verdict (allow,
   step-up, deny) and every mandate voucher lands there as an HCS message.
2. `npm run e2e:audit` — writes probes, then reads them back through the
   mirror node. An audit record that never becomes readable never happened.
3. `npm run uaid:register` — inscribes the operator's HCS-11 AI-agent
   profile carrying its deterministic HCS-14 UAID (F25), and reads it back
   from the account memo. Every HCS audit record carries that UAID, so the
   evidence log says *who* acted, not just what happened.
4. `npm run treasury:topup` — when the payer balance drops below threshold
   and no live top-up exists, creates a treasury-signed HIP-423 schedule
   that executes the top-up at expiry (F26). The demo cannot strand on an
   empty payer; the schedule's execution fee falls on the funded treasury,
   never the depleted payer.

What the developer gets: a reconstructable evidence trail (HCS), a
resolvable operator identity (HCS-14/ERC-8004-shaped), and liveness (the
treasury leg) — three separate Hedera primitives doing what each does best.

## Invariants the DX rests on

- No `.env`, no plaintext keys anywhere: Key Ring seal → single-operation
  unseal → zeroed buffer (`withSecret`). `verify` scans for key-shaped
  literals on every run.
- The fee payer is never hardcoded: it is read from the live facilitator
  challenge, and boot fails fast without it.
- Over-ceiling is step-up, never silent deny and never silent allow: the
  policy engine owns the ceiling; the SDK spend controls stay uncapped so
  escalation reaches the human.
- Cuts are documented with cause (F24 Substreams, F27 `upto`): if a
  primitive cannot be compiled, observed, or stocked here, it is cut in
  writing — not demoed as theater.
