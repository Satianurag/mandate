# Current findings and remediation observations

This replaces the pre-audit claims log. The original observations remain in Git at
`f5ed2be`; they must not be read as proof of the repaired branch. Current public run
facts are in [verification/live-proof-2026-09-11.json](verification/live-proof-2026-09-11.json)
and [verification/ledger-paid-lifecycle-2026-09-11.json](verification/ledger-paid-lifecycle-2026-09-11.json).

| Finding | Reproduction / observed behavior | Current handling |
| --- | --- | --- |
| Scope was fragmented | Batch channel bypassed the separate policy gateway | One batch broker pins reviewed scope and durable accounting; reputation never grants additional authority |
| Rolling checks raced | Twelve approvals could all see the same unreserved budget | Cross-process transactional integer reservations; signed unknown outcomes retain liability |
| Reused client missed later charges | A lifetime `audited` boolean counted only one response | Request-correlated hooks and per-response accounting regressions |
| Presence accepted fabricated signatures | A 65-byte all-zero value passed length validation | Canonical typed data, expected principal, freshness and cryptographic verification |
| Address verification was called payment consent | Device confirmed an address, not an action | One-time action-bound signatures; presence is distinct; no automatic scope widening |
| Merchant charged before data retrieval | Graph errors could follow a financial commitment | Prepare result first; persist original response/receipt; read-only reconciliation never reprocesses payment |
| Static console asserted success | Inputs and approvals were not connected | Real backend state; authoritative hardware/funding/recovery stages; no fabricated fleet |
| Fixed query ignored caller intent | Supplied query was echoed while another query ran | The actual bounded read-only document is executed and provenance is returned |
| Feedback values were conflated | Heterogeneous values were averaged as reputation | Raw measurements and counts are advisory; no universal trust rating |
| Claim/sweep recovery gap, observed live | Claim confirmed, next sweep returned `nothing_to_settle` | Persist stages separately, read existing receiver liability, retry only definite pre-send visibility errors |
| Refund receipt visibility gap, observed live | Funds returned, then RPC could not read receipt block | Persist transaction immediately; same-block read retry; exact multicall/transfer/balance reconciliation |
| HCS transport failures, observed live | Some native submissions returned `UNKNOWN` | Durable outbox, bounded retries; final state has 47 independently verified records and zero pending across workspace/buyer/merchant journals |
| Fully-spent lifecycle had no terminal path | Ceiling and accepted spend could match while the Mandate remained active and could not be replaced | Independently reconcile channel liability and merchant settlement, then close as `fully_spent` without a zero-value refund; a real 0.01-USDC cycle reached `closed` and a fresh unfunded Mandate preserved the history in a separate read-only archive |
| Exhausted authority still offered Run | The backend safely denied the extra request, but the UI allowed a doomed submission | Remaining lifetime authority now participates in action availability; Run disables before submission and points to settlement/closure; real HTTP/SQLite browser regression covers it |
| Research fallback changed task meaning | A preferred-source list could silently move the query to another testnet population | The reviewed source chain and exact deployment are part of the task and payment URL; changed/unavailable deployments fail closed without cross-chain substitution |
| Dependency advisories | Initial scan included a critical protobuf.js finding | Tested patched versions, reproducible image-parser guards, explicit remaining upstream warning |

## Important distinctions

Both live financial funding results were clear-basic. Official descriptor lint passed, and a
separate physical-device development proof now shows `calFilters=success` and
`verdict=erc7730` on EthereumTest via a loopback Ledger test-CAL bridge. That proof
is not production CAL/registry acceptance, and it moved no funds. The Linux clean
build ran without secrets; it was not a funded USB-less broker. The paid restart
proof used a fresh HID-disabled process on the Mac, not a physically disconnected
Ledger. Test fixtures are isolated test inputs, not evidence of live payment success.

Historic optional Graph direct-payment, Hedera batch, treasury, Substreams and
identity experiments are not rolled into the Base Sepolia workspace's live claim.
Read [AUDIT-REMEDIATION.md](AUDIT-REMEDIATION.md) and [RECOVERY.md](RECOVERY.md) for the
accepted flow and explicit scope of recovery.
