# Threat model

## Scope

The verified deployment is a single trusted operator host with a constrained
consumer, Base Sepolia USDC, a local merchant/facilitator, and Hedera testnet evidence.
Mainnet use is disabled. This is not a claim of an independently audited production
wallet, uniqueness oracle, general agent sandbox, or trustless data marketplace.

## Protected boundaries

Untrusted consumers cannot select another recipient/token/network, widen the
reviewed query, invoke initial funding, administer the operator, or recover money.
The live Docker probe attempted these operations and was denied. The consumer has
no network interface outside its container, host credentials, or host-data mounts.
It asks the trusted relay for a permitted task instead of receiving signing keys.

The broker rejects unparseable amounts, unexpected requirements, expired scope,
redirects, caller-supplied payment credentials and exhausted limits. Atomic integer
reservations close the check-then-spend race. A submitted request of unknown outcome
retains its reservation until the original evidence establishes what happened.
A new process cannot attach different scope to the same mandate identity.

Device approvals are cryptographically verified against the configured principal.
Optional step-up approvals bind an action, nonce, amount, chain, recipient and
expiry and are consumed once. Address verification and optional human-presence
attestations are not payment approval. The core batch workspace does not silently
override a blocked limit by asking for an unrelated signature.

## Trusted components and residual risks

The operator host can observe secrets while they are used. `wallet-cli` receives
its Key Ring password in a child environment; another process with the same host
user authority can inspect it. A protected Key Ring member is custody plumbing,
not process isolation or a trusted execution environment. The consumer boundary
works only when the consumer is actually launched with the supplied confinement.

The broker and facilitator create JavaScript strings/account closures from secret
bytes. Buffer cleanup is best-effort and cannot promise erasure of those copies.
A compromised broker with the delegated key can misuse authority up to the
contractual channel bounds; broker-only URL/window/expiry rules are not guaranteed
against compromise of the broker itself.

The merchant can fail to deliver useful work or honestly report incomparable data.
Preparing a read-only result before charging limits one failure mode, not all
service-quality risk. Feedback counts and heterogeneous measurement values are
not a trust score or proof of identity uniqueness. Reputation does not enlarge the
reviewed spending authority.

On-chain proof still relies on the configured testnet and RPC responses. The
implementation checks the chain and matching receipt/calldata/transfers and uses
consistent snapshots. This is not a light-client proof, audited contract claim,
or protection against a fully compromised operator/RPC environment.

A local event hash chain detects changes relative to a known head. It does not
stop the operator rewriting all local files before any external anchor exists.
Confirmed HCS anchors bind hashes and publisher signatures to consensus; they do
not prove the original data source was honest. Pending anchors are never described
as already confirmed. Readback failures remain visible.

See [dependency security](DEPENDENCIES.md). Patched transitive versions and a
version-checked image parser guard are applied reproducibly. The upstream
`elliptic` implementation warning remains; the repository does not claim a zero-risk
supply chain or a clean advisory report by hiding transitive packages.

## Deliberately excluded claims

No mainnet financial operation is supported. The live test did not demonstrate a
physically unplugged or remotely provisioned VPS broker, on-device ERC-7730 labels,
a running LLM fleet, universal ERC-8004 reputation scores, or a permissionless
network-wide identity/uniqueness proof. Descriptor lint, unit tests, recorded device
traces, and real chain transactions are different kinds of evidence.

Ledger explicitly documents the same-user environment risk and device-free
post-provisioning decryption:
https://developers.ledger.com/docs/ai-tools/ledger-cli
