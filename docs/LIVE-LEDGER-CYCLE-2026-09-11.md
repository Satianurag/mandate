# Live Ledger-funded lifecycle — 11 September 2026

This record covers one fresh, minimal-cost, end-to-end acceptance run performed on
11 September 2026. It supplements the earlier 0.10-USDC multi-call/refund proof; it
does not replace or rewrite that history.

## Scope and claim boundary

- Payment network: Base Sepolia (`eip155:84532`) only.
- Paid asset: testnet USDC, 6 decimals.
- Research source: the exact reviewed Agent0 BSC Chapel deployment.
- Ledger payer: `0x57a2a47Ca22AE52867c5313c4d9ab43070D7C202`.
- New payer signatures: exactly one funding authorization.
- New accepted spend: exactly 10,000 base units (0.01 test USDC).
- Final implementation commits: `95051f9d99e98bbf756d21abfc361f59d962acae`
  and `b1c17fa0b513b1c363425e6865ce68004793aa27`.
- No mainnet operation, deployment, tunnel change, Git push, or new HCS publication
  was performed.

The recorded funding trace was **clear-basic** with `calFilters=error` and no origin
token. This proof therefore does not claim production ERC-7730/CAL acceptance or
that every broker policy field appeared on the device. The reviewed workspace and
the trusted broker remain separate enforcement boundaries.

## Observed sequence

| Stage | Live observation |
| --- | --- |
| Read-only preflight | Base Sepolia chain ID, reviewed Agent0 deployment, unsigned HTTP 402 offer, USDC contract and sealed session were all available; no signature or payment occurred. |
| Device identity | The connected Ledger address exactly matched the reviewed payer; address reading requested no signature. |
| Funding and paid work | Request `632ef57a-e7b1-4758-9aed-bb6bd91b4073` moved through device wait, signature, execution and success. Transaction `0xf2b8cbb202b2668363d8df5e38afeba6553b58998c9c84ac44221e4ab2d71183` succeeded at block `46685609`. |
| Useful result | Five registrations were compared at BSC Chapel block `130428783`. Registration `158` had the best-supported evidence coverage among the returned records. The UI explicitly says this is not a universal quality or trust guarantee. |
| Budget denial | A second request was rejected with `Lifetime budget exhausted`; no additional charge was accepted. The UI now disables Run before submission when lifetime authority is exhausted. |
| Merchant claim | Transaction `0x4b2f4f38090f82574712a5e17e1fb9c47886c342a9bf5cdcfe310db3923ad699` succeeded at block `46685618`. |
| Merchant settlement | Transaction `0xdc8a1222d4a64139398a9b1dc6eda18fa3ae13f0c3f77ef918a083f3166dc1aa` succeeded at block `46685638` and transferred exactly 10,000 USDC base units to the reviewed receiver. |
| Fully-spent closure | The broker independently reconciled 10,000 spent, zero reserved, claimed liability equal to settled revenue, and closed the Mandate at read block `46685663`. No zero-value refund or refund task was created. |
| Repeat use | A fresh source-bound Mandate was saved with a new salt and storage root. It remained unfunded with zero spent/reserved and requested no additional signature or payment. Fifteen prior tasks remain inspectable in a separate read-only archive and do not participate in current authority or accounting. |

## Independent chain readback

A separate read-only Base Sepolia check retrieved successful receipts for funding,
claim and settlement. The funding transaction contained the exact 10,000-base-unit
USDC movement from the payer into the stock batch-settlement flow. The settlement
receipt contained the exact 10,000-base-unit transfer from escrow to the merchant.
The final channel snapshot reported:

- channel balance: 10,000 base units;
- claimed liability: 10,000 base units;
- receiver aggregate claimed: 40,000 base units;
- receiver aggregate settled: 40,000 base units;
- withdrawal amount: zero;
- refund nonce: zero.

The aggregate receiver values include earlier verified channels for the same
receiver; the per-channel claimed liability and settlement balance delta establish
this run's exact 10,000-base-unit lifecycle.

## Verification gates

After the live cycle and the exhausted-authority UI fix:

- all four workspaces built successfully;
- `npm test` passed 174 tests: facilitator 5, gateway 161, mandate service 6,
  Hedera service 2; zero failures or skips;
- `npm run test:ui` passed against a real local HTTP/SQLite application with zero
  network mocks or financial operations, zero reported desktop/mobile axe
  violations, the pre-submission exhausted-authority regression, and the
  prior-Mandate read-only archive regression;
- `npm run verify:linux` built from the committed source and lockfile, then
  passed the same 181 checks inside a container with no runtime network, host
  credentials, host state or USB device;
- `git diff --check` passed.

## Final local runtime

The exact committed backend was restarted after verification. Operator health was
HTTP 200 with `signingAtStartup=false`; the merchant returned the expected unsigned
HTTP 402 offer; the facilitator returned HTTP 200. The current Mandate remained
unfunded with zero current tasks and no uncertain operation. API version 5 returned
15 result-free prior-task summaries; explicit authenticated inspection retrieved the
completed 0.01-USDC task. Historical merchant events were excluded from the fresh
Mandate view. Tailscale Funnel status was captured before and after and compared
unchanged.

## Public-safe evidence

The machine-readable record is
[`verification/ledger-paid-lifecycle-2026-09-11.json`](verification/ledger-paid-lifecycle-2026-09-11.json).
It intentionally excludes operator tokens, cookies, Key Ring passwords, private
capabilities, sealed key material, raw signatures, complete SQLite state and local
login URLs.
