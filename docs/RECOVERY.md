# Recovery without another payment

First preserve the channel snapshots, broker/merchant databases, reviewed config,
sealed session key, and Key Ring member. Never delete state or rotate a key merely
because an HTTP request failed. A missing receipt is not proof that no payment was
made. Never reuse a refunded channel or fund it again by changing a label.

## Lost response or uncertain paid request

Use the original request ID in the workspace and select **Reconcile existing
receipts**. The broker retrieves the original merchant response using its stored
signed payload. This mode never invokes another financial operation. A completed
receipt must match the channel, price and cumulative signed liability; otherwise
the reservation remains unresolved. Do not create a new request ID as a workaround.

CLI: `npm run mandate:reconcile -- --request-id ORIGINAL_ID`.

## Funding rejected before any signature

The durable deposit-attempt guard may remain pending after a rejected device
prompt or an interrupted process. Reconciliation reads the pinned channel on-chain.
It can reset an unsigned attempt only when no signature event exists and the channel
has no funded balance. Resetting that bookkeeping does not authorize funding: the
operator must explicitly review and initiate a new attempt. A recorded signature
forbids this shortcut, including when its final network outcome is unknown.

## Claim succeeded but sweep failed

Claims and sweeps have independent records. The merchant lifecycle reads outstanding
receiver liability and can sweep it even when there are no newly claimable vouchers.
It retries only a definite pre-transaction `nothing_to_settle` error, not an ambiguous
send error. The successful sweep must reconcile with actual receiver token balances.
A later success is linked to earlier uncertainty; the original failure is not erased.

## Refund sent but confirmation failed

Do not press a new payment/funding button. The refund transaction is saved before
receipt reads. Reconciliation uses that original transaction, or retrieves the
original completed receipt from the authenticated local merchant. It verifies the
stock multicall's exact channel and amount, the token transfer to the expected payer,
refund nonce and before/after balances. It never submits a second refund to repair
an unavailable RPC read. A previously confirmed refund is idempotent.

The 11 September run encountered a public RPC `block not found` response after the
real refund succeeded. The same original transaction was later verified and the
workspace changed from uncertain to reconciled. That is a recovery proof, not a
reason to hide the intermediate failure.

## Stop versus return of funds

Stop persists revocation and prevents new work/signing. It does not reverse prior
charges or automatically erase merchant liability. Claim/sweep existing liabilities,
then request the remaining-funds refund. The UI labels returned money only after
matching on-chain proof. A stopped or refunded agent capability is unusable.

## HCS failures

Publish pending evidence explicitly. A failed anchor stays in the durable outbox.
Retries first consult mirror readback so a lost submission response need not incur
a duplicate fee. Publisher signature, original event hash, sequence and running hash
must verify. A successful submit call alone is not the acceptance condition.

## Legacy configuration and old balances

Version-1 `mandate.yaml` and old `state/mandate/client` records are not the authority
used by the new workspace. They are intentionally preserved. Do not silently import
old displayed balances, mint a replacement salt, overwrite the session key, or call
an old helper that implicitly reopens a channel. Independently inspect the original
channel and merchant liabilities before any separate legacy recovery operation.
The verified new 0.10-USDC envelope and its refund do not claim to recover old funds.
