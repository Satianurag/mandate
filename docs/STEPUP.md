# Action approval, presence and funding are different

The operator workspace funds one reviewed Base Sepolia channel. Its limits are not
silently widened when a request is blocked. A new scope needs a separate explicit
review; the funded channel is never silently topped up.

The optional exact-payment adapter uses `requireDeviceApproval` for a one-time
EIP-712 action approval. It checks the expected operator, network, receiver, asset,
amount, request identity, nonce and expiry and consumes the nonce once. Device
rejection, timeout, a different signer or a fabricated signature fails closed.
This is not `getAddress(checkOnDevice)` disguised as payment consent.

Human-presence attestations are optional, separately validated statements. They do
not authorize a transfer, establish human uniqueness, or expand a budget. Their
expected principal comes from trusted configuration, not the untrusted attestation.

The actual funding run recorded clear-basic. A separate physical ERC-7730 proof
exists for the stock Base Sepolia USDC `ReceiveWithAuthorization` typed data using
Ledger's development test-CAL path on EthereumTest. There is still no claim of a
production-deployed ERC-7730 descriptor for the custom action-approval type. The
obsolete draft descriptor from the prototype is excluded; the linted USDC/batch
descriptors are separate. See [../DX.md](../DX.md) for device evidence and
[threat-model.md](threat-model.md) for the trust boundary. Do not turn on blind
signing as an automatic failure fallback.
