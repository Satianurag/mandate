# Developer experience feedback

> Ledger's ETHOnline brief states that DX feedback is **judged equally with
> code**. This file is written continuously during the build, not reconstructed
> from memory on the last day.

Format — one entry per friction, with evidence a maintainer can act on:

```
## Friction NN — one-line summary
Docs page:  <url or path>
Expected:   what the docs led me to believe would happen
Observed:   exact stderr / exit code / timestamp
Cost:       minutes lost
Fix:        proposed doc diff or PR link
```

Target: ten entries, with a proposed patch attached to two or three. Entries
without evidence are opinions; entries with a diff are contributions.

---

## Friction 01 — `/supported` is the fastest way to validate a facilitator, and it is not signposted

**Docs page:** https://docs.hedera.com/solutions/ai/x402
**Expected:** the Hedera x402 page would show me how to confirm, in one call,
that a given facilitator supports Hedera and what `feePayer` to expect.
**Observed:** the page names Blocky402 as a supported facilitator but does not
mention the `/supported` endpoint, the CAIP-2 network string, or the fee-payer
discovery flow. I found it by reading the facilitator spec separately. A single
`curl` returns everything needed to start:

```
$ curl -s https://api.testnet.blocky402.com/supported
{"kinds":[...,{"x402Version":2,"scheme":"exact","network":"hedera:testnet",
 "extra":{"feePayer":"0.0.7162784"}}], ...}
```

**Cost:** ~25 minutes, spread across three docs sources.
**Fix:** add a "Verify your facilitator" snippet to the Hedera x402 page with
exactly the curl above and a one-line reading of the response. Proposed as a
docs PR.

---

## Friction 02 — Key Ring headless usage is documented, but the VPS story is the whole feature and is buried

**Docs page:** https://developers.ledger.com/docs/ai-tools/ledger-cli#key-ring
**Expected:** given that "deploy Key Ring to environments without USB ports" is
a headline hacking direction on the ETHOnline track page, I expected the docs
to open with the provisioning→transport→headless-decrypt lifecycle.
**Observed:** stdin/stdout support and `WALLET_PASS` are documented, but as
notes after the file-based examples. The question a hackathon builder actually
has on minute one — *what exactly do I move to the VPS, and what do I not?* —
is not answered directly.
**Cost:** TBD (fill in after Day 1 provisioning).
**Fix:** a short "Headless deployment" section showing the two-machine flow end
to end. Draft to attach.

---

## Friction 03 — `ring init` requires the Ledger Sync device app, and nothing says so

**Docs page:** https://developers.ledger.com/docs/ai-tools/ledger-cli#key-ring
**Severity:** blocking for a first-time user.

**Expected:** the Key Ring docs give exactly one setup instruction —

> "Run `ring init` once to provision the key ring via the device, and always
> protect it with a password."

Nothing about a prerequisite device app. The ETHOnline track page makes
`wallet-cli ring` a headline requirement and is likewise silent.

**Observed:** on a factory-fresh device, unlocked, `ring init` fails:

```
$ wallet-cli ring init --name mandate-host
Generating member credentials…
Connect device, open Ledger Sync app — provisioning your Ledger Key Ring…
[✖] An unknown error occurred talking to the Ledger.
```

The Key Ring is LKRP, and LKRP's device-side counterpart is the **Ledger Sync**
app (github.com/LedgerHQ/app-ledger-sync). It must be installed AND open before
`ring init` will do anything.

The gap is specifically between the two clients. Ledger's own writeup of LKRP
in Ledger Live says that when you enable Ledger Sync there, *"the Ledger Sync
device app is installed automatically and the user gets prompted to open it."*
**wallet-cli does neither** — it does not install the app, does not prompt, and
reports the failure as "An unknown error occurred talking to the Ledger."

**Cost:** ~35 minutes, most of it spent suspecting USB, the cable, and the
device lock state — because the error names none of the three things actually
wrong (app missing / app not open / that an app is needed at all).

**Fix — three separate, cheap improvements:**

1. **Docs.** Add a Prerequisites line to the Key Ring section: *"`ring init`
   requires the Ledger Sync app on the device. Install it from Ledger Live
   (My Ledger → Ledger Sync), then open it before running `ring init`."*
2. **Error message.** Replace "An unknown error occurred talking to the Ledger"
   with the actual precondition, e.g. *"The Ledger Sync app is not installed or
   not open. Install it from My Ledger, open it on the device, and retry."*
   The CLI already knows which app it wants — it printed the name one line
   earlier.
3. **Preflight.** `wallet-cli ring init` could detect the missing app the way
   Ledger Live does and either install it or say plainly that it cannot.

Item 2 alone would have saved the whole 35 minutes. Happy to open a docs PR for
item 1.

---

## Friction 04 — Graph docs print the testnet x402 hostname backwards

**Docs page:** `@graphprotocol/client-x402` README (Environments table)
**Expected:** `https://testnet.gateway.thegraph.com/api/x402` with `chain: base-sepolia`.
**Observed:** that name is NXDOMAIN. The live host is
`https://gateway.testnet.thegraph.com/api/x402` — HTTP 402, `exact@eip155:84532`,
Circle Sepolia USDC, amount 42 (measured 10 Sep 2026). Production
`gateway.thegraph.com/api/x402` still bills `eip155:8453` for a Sepolia subgraph
ID (F31).
**Cost:** days assuming the documented host was the product.
**Fix:** publish the swapped hostname (or a CNAME). Mandate pays the live host
(`npm run e2e:graph-x402`), never mainnet.

---

## Friction 05 — Substreams Base Sepolia: Pinax lists it, StreamingFast markdown does not

**Docs page:** Pinax app network list vs StreamingFast supported-chains markdown
**Expected:** one canonical gRPC host for `base-sepolia` and a named `substreams run` example.
**Observed 10 Sep:** `basesepolia.substreams.pinax.network` resolves
(`64.203.83.125`, `209.249.216.189`); `base-sepolia.substreams.pinax.network`
is ENOTFOUND. StreamingFast docs still show Base **mainnet** only.
**Cost:** ~25 minutes.
**Fix:** one row in both providers' chain tables: host, TLS port, auth header.

---

## Friction 06 — Hashio rejects Foundry's 32-byte hash as `eth_getCode` block tag

**Docs page:** https://ethereum.org/en/developers/docs/apis/json-rpc/#eth_getcode
and https://github.com/hashgraph/hedera-docs/blob/main/evm/differences/json-rpc-differences.mdx
**Expected:** `forge script --broadcast` against Hashio deploys CREATE2 vanity
contracts (x402 `contracts/evm/README.md`).
**Observed 10 Sep:** Foundry sent `eth_getCode [CREATE2, 0x<32-byte hash>]`.
Hashio `-39012` (QUANTITY|TAG is `"latest"` / `"0x<number>"`, not a hash).
Adapter maps that slot; `--slow` waits for Hashio confirmation before the next
nonce. After that, all `0x4020…` vanity addresses have code (F28).
**Cost:** one documented RPC rewrite + sequential broadcast; no custom scheme.
**Fix:** keep the Hashio adapter; never invent a Hedera `upto` scheme.

---

## Friction 07 — upto `settleWithPermit` simulation must eth_call *as* the facilitator

**Docs page:** https://github.com/x402-foundation/x402/blob/main/contracts/evm/src/x402UptoPermit2Proxy.sol
**Expected:** wiring `toFacilitatorEvmSigner` with a viem `publicClient.readContract` is enough for `/verify` to simulate `settle` / `settleWithPermit`.
**Observed 10 Sep (live Base Sepolia, two Ledger EIP-712 taps):** `/verify` returned `permit2_allowance_required` even after the client attached `eip2612GasSponsoring`. The proxy reverts `UnauthorizedFacilitator` unless `msg.sender == witness.facilitator`. viem `eth_call` defaults `from` to `0x0`, the sim always fails, and the stock diagnostic then reports missing Permit2 allowance (which is still 0 until the sponsored permit lands).
**Cost:** two full device sessions (~15 minutes) chasing a Permit2 allowance that EIP-2612 is supposed to replace.
**Fix:** pass `account: submitter.address` on facilitator `readContract` so simulation runs as the advertised facilitator. x402's `UptoEvmScheme` itself is correct; the signer wiring is the footgun.

---

## Friction 08 — CREATE2 x402 escrow on Hedera cannot receive HTS USDC

**Docs page:** https://docs.hedera.com/learn/core-concepts/tokens/airdrops
and x402 `contracts/evm/README.md` (CREATE2 vanity addresses)
**Expected:** after Circle faucet USDC on the payer, stock
`BatchSettlementEvmScheme` deposits via Permit2 into the canonical
`0x4020…0003` escrow on `eip155:296`.
**Observed 10 Sep:** payer `0.0.10440893` holds 20 USDC. Merchant 402 correctly
advertises `assetTransferMethod=permit2` (HTS facade has no EIP-3009).
`USDC.approve(Permit2)` succeeds (`0x4147c417…bd0422`). Facilitator `/verify`
simulates `deposit` and Hashio returns
`TRANSFER_FROM_FAILED, TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`. The escrow account
`0.0.10454274` is `memo=lazy-created account`,
`max_automatic_token_associations=0`. `TokenAssociateTransaction` →
`INVALID_SIGNATURE`. `ContractUpdateTransaction` →
`MODIFYING_IMMUTABLE_CONTRACT`. HIP-904 airdrop is pending and unclaimable
by bytecode that has no HTS associate/claim function.
**Cost:** one Circle faucet wait + three live `/verify` rounds after funding.
**Fix (Hedera / x402):** CREATE2-deployed EVM contracts that must hold HTS
need `maxAutomaticTokenAssociations=-1` at lazy-create time, or an official
associate path that does not require an admin key. Do not ship a wrapper
scheme.

