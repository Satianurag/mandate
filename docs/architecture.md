# Architecture and authority

This is the current testnet workspace architecture, not the pre-audit prototype.
The application uses stock x402 clients, resource servers, and settlement contracts;
it does not introduce a custom token, payment header dialect, or escrow contract.

## Components

The operator HTTP service is the only submitted control plane. It authenticates
operator sessions and scoped consumer capabilities, checks Host/Origin/CSRF, stores
tasks, and invokes the trusted broker. It binds to loopback and provides no CORS
permission for a public website to spend on the user's behalf.

The broker in `mandate.ts` is the one batch execution path. `scope.ts` validates
network, asset, receiver, receiver-authorizer, resource URL, GET method, expiry and
price. `journal.ts` binds the immutable mandate/channel identity and atomically
reserves integer base units before signing. A process lease excludes concurrent
channel signers; reservations also use SQLite transactions across processes.

The isolated consumer in `agent/consumer.mjs` has no payment implementation. The
container runs non-root with a read-only filesystem, dropped Linux capabilities,
no external network, and no host-data or Docker-socket mount. Its host-side relay
holds only a query-scoped capability and forwards a small task API. The relay and
operator are trusted; the consumer is not. Giving a different agent unrestricted
access to the Mac user account would defeat that boundary.

The merchant prepares the actual bounded Graph query before payment processing,
persists outcomes, and retains the original settlement headers. The self-hosted
facilitator uses the installed x402 scheme, funded with testnet gas. Merchant
claiming and sweeping are different durable steps. The automatic manager handles
normal operation; authenticated local controls allow explicit demonstration and
recovery of already-claimed but unsettled revenue.

The evidence publisher hashes the durable event chain, signs anchors with the
configured testnet publisher key, submits to HCS, and waits for a receipt. Pending,
failed, and confirmed are distinct states. Readback validates the signature against
an independently resolved publisher public key and compares the original event
hash, sequence, and running hash. A public topic ID or UAID alone is not authorship.

## What is enforced where

| Constraint | Enforcement |
| --- | --- |
| Channel payer/session, receiver/authorizer, asset and funded liability | Stock escrow and channel/voucher signatures |
| Base Sepolia workspace; optional allowed testnet adapters | Explicit parser, chain probes, signer guards and registration allowlists |
| Resource origin/path, GET-only, per-call and rolling limits, task expiry | Trusted broker checks plus durable integer reservations |
| No silent extra funding | One-deposit guard; resume clients have no deposit signer |
| Stop new requests | Durable stopped/refunded state, signing guards and capability revocation |
| Agent cannot access broker credentials | Separate constrained container plus scoped relay; not merely encryption |
| Refund completed | Matching calldata, receipt, token transfer and same-block before/after state |

The device signs the actual funding authorization. It does not attest to the
broker's rolling window, URL allowlist, or task expiry. The stock channel's
`withdrawDelay` is a recovery timing parameter, not the expiry of agent authority.
The live device trace was clear-basic, not CAL/ERC-7730 label delivery.

## Accounting and failure semantics

Amounts stay in token base units. Budgets are separated by mandate/network/asset;
no sum of HBAR units and USDC units is treated as a valuation. Pending signed
liability remains reserved when an outcome is unknown. Retrying with the same
identifier cannot create a replacement charge or reopen a funded envelope.

A merchant receipt lookup marked `x-mandate-reconcile` is read-only: it can return
an existing completed response or an unresolved error, but never enter Graph,
verification, signing, or settlement. A receipt is checked against the stored
signed request before updating local bookkeeping.

Refund submission records the transaction before remote receipt reads. Public
RPC nodes may briefly disagree about availability of a just-confirmed block;
reads retry the same block rather than mix snapshots. Recovery parses the stock
multicall and requires exactly one matching channel/amount refund. A successful
HTTP response, transaction hash, or returned `success` flag alone is insufficient.

A refunded channel may still expose gross `balance == totalClaimed` on-chain.
Those values represent accounted liability, not spendable remaining funds. The
workspace presents the confirmed returned amount and prevents further execution.

## Persistence and operations

`state/live/operator` contains authentication, tasks and reviewed configuration.
Each mandate's storage root contains `broker.sqlite` and stock `client` snapshots.
`state/live/merchant` contains durable merchant outcomes and channel snapshots.
Back up all of these together with the encrypted key material. Keep the Key Ring
member/password under operator control. Do not put an agent or container in charge
of the backup or of the Docker daemon.

Schema-1 configuration is not silently promoted to schema 2. Historical channel
records remain where they were, including when their owner has not supplied enough
information for a safe migration. There is no default redeposit on missing state.

Primary lifecycle reference: https://docs.x402.org/schemes/batch-settlement
