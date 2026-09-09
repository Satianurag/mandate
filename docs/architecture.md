# Architecture — which rail does what

Locked after live verification on 2026-09-08 (`docs/FINDINGS.md`).
**Everything runs on testnet.** No mainnet dependency except one optional
$0.01 proof-of-integration payment.

## Rails

| Purpose | Scheme / network | Facilitator | Cost |
|---|---|---|---|
| **The mandate envelope** | `batch-settlement@eip155:84532` (Base Sepolia) | self-hosted (`@mandate/facilitator`) | testnet, free |
| **Hedera paid service** | `exact@hedera:testnet` | Blocky402 *(required by the Hedera track)* | testnet, free |
| **Evidence log** | HCS topic, Hedera testnet | — | testnet, free |
| Graph proof-of-integration *(optional)* | `exact@eip155:8453` (Base mainnet) | Graph gateway | **0.01 USDC real** |
| Graph bulk reads | authenticated gateway, API key sealed in Key Ring | — | free tier |

### Why the envelope is not on Hedera

No escrow contracts are deployed for `batch-settlement` on the Hedera relay
chain — the scheme lives on Base Sepolia. Self-hosting the facilitator is now
proven (we run our own), so the remaining work is a contract deployment on
chain 296: a Day-4 stretch, not the critical path.

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
| facilitator submitter | Key Ring (`mandate-facilitator`) | settlement txs | Base Sepolia ETH (gas) |
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
| The Graph | compose 2+ products; live data | Agent0 (reputation) + x402 (402 flow + proof-of-integration) |
| The Graph | Subgraph MCP **or** Substreams **or** x402 | x402 path live; Substreams cut per cut order (F24: no Base Sepolia endpoint on either provider) |
| Hedera | live x402 service via Blocky402 | Hedera paid service |
| Hedera | HCS audit, scheduled tx, ERC-8004/HCS-14 (bonus) | evidence layer (every record carries the operator UAID, F25), treasury leg, identity (HCS-11 profile via `uaid:register`) |
