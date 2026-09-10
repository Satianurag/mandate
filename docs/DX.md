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
   opens the on-chain escrow channel (EIP-3009 USDC). Live Nano S+ proof:
   `npm run e2e:erc7730-device` → structured EIP-712 (`clear-basic`), **not**
   labeled ERC-7730 (`calFilters=error` without a partner `originToken`; F32).
   Local descriptor lint: `npm run e2e:erc7730`. Preview: [ERC-7730 Tester](https://app.devicesdk.ledger.com/clear-signing-tools).
   **Do not claim production labeled Clear Signing until `e2e:erc7730-device` prints `ERC7730_DEVICE_CLEAR`.**
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
2. `npm run probe:reputation` — live Agent0 reputation via **Subgraph MCP
   discovery**, including Hedera `0.0.x` accounts (resolved via their EVM
   alias, F20). Prints the MCP tool names used.
3. `npm run e2e:graph-x402` — pay Graph's **testnet** x402 gateway
   (`gateway.testnet.thegraph.com`, Base Sepolia USDC) against a subgraph
   that actually has testnet-network allocations (F34). Docs still print
   `testnet.gateway.thegraph.com`, which does not resolve (F8). Never pay
   production `eip155:8453` (F31). Agent0 Base Sepolia ids live on the
   production Graph Network — the testnet gateway 402s them, then 200s
   `subgraph not found`.
4. Every payment is policy-judged before creation: allow, step-up (device
   tap), or deny — the F18 weighted hybrid with hard gates. Deny reasons
   cite the mandate line that fired.
5. Query volume is what the mandate envelope is *for*: hundreds of sub-cent
   queries inside one hardware-approved budget.

What the developer gets: the pay-per-query gateway with the missing piece —
an authorization story that survives contact with a finance team.

## Hedera — evidence, identity, and stock `exact@hedera:testnet`

1. `npm run provision:hcs` — the audit topic. Every verdict (allow,
   step-up, deny) and every mandate voucher lands there as an HCS message.
2. `npm run setup:merchant` — a distinct `SERVICE_PAY_TO`. Stock exact
   settlement cannot be a self-transfer (Blocky402 verify nets to zero).
3. `npm run e2e:payment` (alias `e2e:hedera-exact`) — live `exact@hedera:testnet`
   in HBAR through Blocky402, then HCS read-back.
4. `npm run e2e:hedera-usdc` — same stock scheme, Circle HTS USDC `0.0.429274`.
   Hedera EVM `batch-settlement@eip155:296` is advertised (F28) but cannot
   receive HTS at the vanity CREATE2 escrow; do not use it as the paid rail.
5. `npm run e2e:audit` — writes probes, then reads them back through the
   mirror node. An audit record that never becomes readable never happened.
6. `npm run uaid:register` — inscribes the operator's HCS-11 AI-agent
   profile carrying its deterministic HCS-14 UAID (F25), and reads it back
   from the account memo. Every HCS audit record carries that UAID, so the
   evidence log says *who* acted, not just what happened.
7. `npm run treasury:topup` — when the payer balance drops below threshold
   and no live top-up exists, creates a treasury-signed HIP-423 schedule
   that executes the top-up at expiry (F26). `npm run setup:treasury` seals
   `secrets/treasury.enc` and prints `MANDATE_TREASURY_ID`.

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
- Cuts are documented with cause (F8 Graph testnet x402, F24 Substreams
  until Pinax run is green, F28 Hedera proxies, F32 ERC-7730 ingest): if a
  primitive cannot be compiled, observed, or stocked here, it is a FINDING
  in writing — not demoed as theater. F28 paid `eip155:296` deposit is
  measured: `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT` on lazy-created CREATE2 escrow.
