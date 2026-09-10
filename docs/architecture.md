# Architecture — which rail does what

Locked after live verification on 2026-09-08 (`docs/FINDINGS.md`).
**Everything runs on testnet.** Graph production x402 bills Base mainnet (F31);
we do not pay it. Testnet Graph x402 is `gateway.testnet.thegraph.com` (F8).

## Rails

| Purpose | Scheme / network | Facilitator | Cost |
|---|---|---|---|
| **The mandate envelope** | `batch-settlement@eip155:84532` (Base Sepolia) | self-hosted (`@mandate/facilitator`) | testnet, free |
| **Hedera paid rail** | `exact@hedera:testnet` (HBAR + Circle USDC `0.0.429274`); merchant (`SERVICE_PAY_TO`) must differ from the Key Ring payer | Blocky402 | testnet |
| **Hedera EVM batch (advertised, not paid)** | `batch-settlement@eip155:296` | self-hosted when `hedera.enc` present (F28) | 402+Permit2 live; HTS deposit blocked on CREATE2 escrow |
| **Evidence log** | HCS topic, Hedera testnet | — | testnet, free |
| Graph proof-of-integration | Subgraph MCP + Agent0 + testnet x402 (`gateway.testnet.thegraph.com`, F8) against a Graph Network **testnet** subgraph (F34). Production x402 bills Base **mainnet** even for a Sepolia subgraph (F31) — we do not pay it | — | testnet |
| Graph bulk reads | authenticated gateway, API key sealed in Key Ring | — | free tier |
| Graph Substreams | Pinax `basesepolia.substreams.pinax.network` (F24 PROVEN, Key Ring `pinax`) | — | Pinax testnet |

### Why the envelope is not on Hedera

Official x402 vanity contracts now have code on Hedera EVM 296 (F28). Circle
USDC there is HTS `0.0.429274` (EVM alias from Hiero `TokenId.toEvmAddress()`),
with no EIP-3009 — stock x402 therefore uses `assetTransferMethod: permit2`.
CREATE2 escrow accounts are Hedera lazy-created immutables
(`max_automatic_token_associations=0`); a Permit2 `deposit` reverts
`TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`. x402's documented Hedera *paid* rail is
still `exact@hedera:testnet` + token ID (Blocky402). The mandate envelope stays
`batch-settlement@eip155:84532` (Base Sepolia USDC).

**This is a feature, not a compromise.** The mandate layer is rail-agnostic by
design: the same policy engine and the same device signature govern a
batch-settlement channel on Base Sepolia and an `exact` transfer on Hedera. A
single-rail demo would not prove that.

### Why the envelope is not against The Graph's gateway

Their gateway offers `exact` only — batch settlement needs server-side support
they do not have, which is exactly what their forum post asks someone to build.
We run the scheme on our own service and hand them the reference implementation.

## Request path

```
agent
  │  ordinary HTTP
  ▼
Mandate gateway: stock wrapFetchWithPayment + judgment hooks
  │  402 ──► onBeforePaymentCreation ──► reputation (Agent0 / Subgraph MCP)
  │                                          │ policy engine
  │                                          ├─ allow    ─► sealed sign ──────┐
  │                                          ├─ step_up  ─► device, ERC-7730 ─┤
  │                                          └─ deny     ─► abort, 403, HCS   │
  │                                                                           ▼
  │                                              stock exact flow: sign ──► upstream
  ▼                                                service verifies, settles after
upstream service ◄──────────────────────────────────────── its handler runs
  │  200 + PAYMENT-RESPONSE
  ▼
onPaymentResponse ──► accrue budget (iff settled) ──► HCS evidence topic
```

The payment mechanics are stock (`x402Client`, the Hedera `exact` scheme,
`wrapFetchWithPayment`, the server harness). Mandate owns exactly the
judgment: what the stock client cannot decide, and what the stock server
cannot record. F22 records the two defects the hand-rolled flow it replaced
was carrying (pay-before-delivery, double settlement).

## Mandate lifecycle

```bash
npm run mandate:keygen        # device address + sealed session key
npm run facilitator:keygen    # sealed submitter + authorizer keys
# fund payer (USDC) + submitter (ETH), then:
cp mandate.example.yaml mandate.yaml   # set salt + receiver
npm run check:mandate
npm run mandate:open          # ONE tap → N voucher-paid calls → HCS record
npm run mandate:refund        # cooperative refund of the unspent deposit
```

One `mandate.yaml` is one mandate: its salt is committed into the channel id,
so re-running with the same salt *resumes* (no new tap, no new deposit) and a
fresh salt opens a new mandate. Channel records persist under
`{storageRoot}/client/*.json` (x402's own file storage — vouchers survive
restarts); server snapshots mirror under the service's state dir.

Custody of every key involved:

| Key | Lives in | Signs | Funds needed |
|---|---|---|---|
| payer (device) | Ledger, never leaves | EIP-3009 deposit only (1 tap) | USDC only — deposits are gasless |
| session | Key Ring (`mandate-session`) | vouchers (fixed receiver, capped) | none — never submits |
| facilitator submitter | Key Ring (`mandate-facilitator`) | settlement txs; also the `eth_call` `from` for upto `settle`/`settleWithPermit` simulation (proxy checks `msg.sender == witness.facilitator`) | Base Sepolia ETH (gas) |
| facilitator authorizer | Key Ring (`mandate-authorizer`) | claim/refund EIP-712 | none |
| graph-gateway | Key Ring | — (API key, Agent0 reads) | — |
| hedera-payment | Key Ring | HBAR transfers + HCS submits | testnet HBAR |

## Non-negotiable invariants

1. **No plaintext secret on disk or in the environment.** Key Ring only.
2. **Every failure degrades toward `deny`.** Unreachable subgraph, unparseable
   price, absent device — none may open the gate.
3. **Never hardcode a fee payer.** Two facilitators advertise two different ones for the same network. Always read it from the live challenge's `extra`.
4. **Never branch on `res.ok` against The Graph.** It returns HTTP 200 with an error body. Inspect the body, never the status alone.
5. **A facilitator 500 is a hard failure, not a retry.** An undecodable
   transaction returns 500, and retrying can double-spend the intent.
6. **The agent never holds a key that can alter its own mandate.**
7. **Mandate ceilings never widen.** Top-up attempts are refused outright;
   more spend is a new mandate (new salt, new tap), never a silent extension.

## Track coverage

| Sponsor | Requirement | Where satisfied |
|---|---|---|
| Ledger | Key Ring CLI, device approval, x402 payment flow | custody + step-up + envelope |
| The Graph | compose 2+ products; live data | Agent0 (reputation, paid 200s) + Subgraph MCP (discovery) + Substreams module (Base Sepolia) |
| The Graph | Subgraph MCP **or** Substreams **or** x402 | MCP discovery; Substreams `x402-payments`; testnet x402 at `gateway.testnet.thegraph.com` (`e2e:graph-x402`). Docs hostname is NXDOMAIN (F8) |
| Hedera | live x402 service via Blocky402 | stock `exact@hedera:testnet` (`e2e:payment` HBAR, `e2e:hedera-usdc` Circle USDC). EVM batch@296 is advertised, not the paid rail (F28) |
| Hedera | HCS audit, scheduled tx, ERC-8004/HCS-14 (bonus) | evidence layer (every record carries the operator UAID, F25), treasury leg (HIP-423 time-locked top-up, `treasury:topup`, F26), identity (HCS-11 profile via `uaid:register`) |
