# Self-contained testnet walkthrough

This is an operator/demo guide, not a claim that a narrated submission video has
already been recorded. Do not present a replay of stored evidence as a new payment.
The existing live workspace can be inspected without spending again.

## Inspect the verified runs

The current local workspace is intentionally left on a fresh, source-bound,
**unfunded** Mandate. Opening it does not replay a payment. Its history retains the
newly completed minimal lifecycle and the earlier larger refund cycle.

### Minimal fully-spent lifecycle

Inspect request `632ef57a-e7b1-4758-9aed-bb6bd91b4073`: one Ledger funding
authorization established a 0.01-USDC lifetime envelope and one paid Agent0
comparison succeeded. Inspect the next blocked request to show that no lifetime
authority remained and no second charge was accepted. Then inspect the successful
merchant settlement and `fully_spent` closure. The closure has zero refundable
amount and no refund transaction.

The public-safe details, exact Base Sepolia transactions, source block, result,
settlement balance delta and independent chain readback are in
[verification/ledger-paid-lifecycle-2026-09-11.json](verification/ledger-paid-lifecycle-2026-09-11.json).
The narration and claim boundary are in
[LIVE-LEDGER-CYCLE-2026-09-11.md](LIVE-LEDGER-CYCLE-2026-09-11.md).
This funding trace was clear-basic; do not describe it as production ERC-7730.

### Multi-call and remaining-funds recovery lifecycle

The earlier proof used 0.10 USDC, accepted three 0.01-USDC calls, blocked a fourth
at the rolling limit, settled 0.03 USDC, and returned 0.07 USDC. Inspect the
reconciled settlement/refund failures: the original error and the actual resolving
receipt remain visible rather than being replaced with success-shaped history.

[verification/live-proof-2026-09-11.json](verification/live-proof-2026-09-11.json)
contains the channel, receipts, query provenance, observed balances and HCS
readback. Agent isolation and the HID-disabled restart are distinct recorded checks.

## Demonstrate a new run deliberately

Use a fresh reviewed scope and small balances, not the refunded channel. Show the
configured token, recipient, lifetime/per-call/window limits and expiry before
requesting the actual Ledger funding authorization. The screen must move through
waiting for signature and confirmed funding based on backend evidence, never a
button saying “I have signed.”

Run the isolated consumer and show useful sourced results. Attempt one request
outside its capability or after the rolling budget is exhausted; it must fail in
the same real broker. Stop new work, demonstrate capability rejection, then show
merchant revenue and confirmed recovery. Explain that the application constraints
are broker-enforced while channel bounds belong to the contract.

Suggested narrative: useful task and reviewed authority; actual hardware funding;
paid work without repeated payer signatures; observable denial; stop/recovery;
matching receipts and one concrete Ledger DX lesson. Use your own narration and
actual hardware footage when producing a competition video. Do not imply that a
lint result supplies device footage or that every optional integration ran live.
