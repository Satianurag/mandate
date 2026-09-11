# Self-contained testnet walkthrough

This is an operator/demo guide, not a claim that a narrated submission video has
already been recorded. Do not present a replay of stored evidence as a new payment.
The existing live workspace can be inspected without spending again.

## Inspect the completed run

Open `npm run console:open` with the local stack running. The envelope should be
refunded, lifetime charges 0.03 USDC, pending liability zero, and returned money
0.07 USDC. Inspect the successful query's real registration data and source block.
Select the blocked fourth request: its rolling-budget failure must remain visible.
Inspect reconciled settlement/refund failures: the original error and the actual
resolving receipt are part of the result, not erased history.

The public proof JSON is safe to inspect without the Mac credentials. Verify the
funding, merchant sweep and refund on Base Sepolia; verify signed anchors on Hedera
testnet. Agent isolation and HID-disabled restart are distinct recorded checks.

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
