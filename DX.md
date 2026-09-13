# Ledger DX — ETHOnline 2026

Paste this file into the Ledger partner form. It is only about the Ledger Agent Stack: Device Management Kit, Ethereum Signer Kit, Clear Signing / CAL, and `wallet-cli ring`. Mandate is a Start Fresh AI-agent workspace that uses that stack as the trust layer, not as branding.

## What we actually wired

| Piece | Version | Role |
|---|---|---|
| `@ledgerhq/wallet-cli` | 2.1.0 | Key Ring (`ring encrypt` / `ring decrypt`) |
| `@ledgerhq/device-management-kit` | 1.9.0 | HID session, discover, connect, open app |
| `@ledgerhq/device-signer-kit-ethereum` | 1.18.0 | Address read + EIP-712 funding tap |
| `@ledgerhq/context-module` | 2.5.0 | CAL / ERC-7730 filters |
| `@ledgerhq/device-transport-kit-node-hid` | 1.0.1 | Node USB transport |

Product split, which the track asks for:

1. **Key Ring holds the spending key.** The broker runs `wallet-cli ring decrypt` over stdin/stdout, uses the bytes once, and drops the Buffer. The model never sees the key.
2. **The physical device funds that wallet.** DMK resolves the Ledger address, then one EIP-712 tap authorizes USDC on Base (`TransferWithAuthorization`). Agents cannot raise the cap.
3. **Later tool payments do not touch USB.** They use the sealed software wallet. Ledger is required again only for allowance increases.

Code: `packages/gateway/src/keyring.ts`, `dmk-session.ts`, `dmksigner.ts`, `origin-token.ts`, `agent-funding.ts`. Descriptor: `docs/erc7730/eip712-USDC-base-mainnet.json` (intent *Authorize USDC transfer*).

```sh
npx skills add ledgerhq/agent-skills
npm i -g @ledgerhq/wallet-cli
npm ci
npm start   # http://127.0.0.1:8410/ — boot does not unlock, sign, or spend
```

Clear-signing on a hackathon device without a partner origin token:

```sh
npm run ledger:test-cal
MANDATE_LEDGER_TEST_CAL_URL=http://127.0.0.1:8427 npm start
```

Open the **ledger-dev Ethereum app** (`CAL_TEST_KEY=1`) before funding. The signing report logs `originToken`, `testCal`, `calFilters`, `verdict` — never the token itself.

Unpaid preflight (CAL filters + optional address read, never a signature):

```sh
node scripts/dev/probe-ledger-preflight.mjs
```

---

## Overall experience with Ledger docs and SDKs

**What worked.** `wallet-cli ring` is the right primitive for “an agent holds a secret it cannot print.” After `ring init`, decrypt is headless. DMK + the Ethereum signer kit are usable from Node once a HID session exists. Address confirmation and EIP-712 funding are two different device actions — that split is the product.

**What was confusing.** The Agent Stack is documented as five products (DMK, Wallet CLI, Key Ring, Clear Signing, CAL). There is no one page that says: Key Ring for the agent key, DMK for the funding tap, CAL/origin token or you are not clear-signing. ETHOnline lists `npx skills add ledgerhq/agent-skills`; the 403 from production CAL, the partner origin token, and the ledger-dev CAL-test app live in other corners of the portal.

---

## Gaps and confusing flows (what we hit)

### 1. Production CAL returns 403 without `LEDGER_ORIGIN_TOKEN`

Without a partner token, production CAL 403s and the stock Ethereum app falls back to legacy or clear-basic. A connected device is easy to misread as “we are clear-signing.” Partner tokens are not self-serve. The working hackathon path is a loopback CAL plus the ledger-dev Ethereum app (`CAL_TEST_KEY=1`). That fork is not on the public “start here” page.

Mandate fail-closes funding unless a partner token **or** `MANDATE_LEDGER_TEST_CAL_URL` is set. The allowance dialog now shows which path is present.

### 2. `DETECT_BLIND_SIGNING` is a reporter, not the screen

DMK’s typed-data trace still emits `DETECT_BLIND_SIGNING` after a successful clear sign. If you treat that step as “the user saw a blind screen,” you will lie in logs. Legacy fallback is `SIGN_TYPED_DATA_LEGACY` / `usedFallback: true`. We classify traces into `erc7730` | `clear-basic` | `legacy-eip712` | `blind` | `unknown`, and we only call it ERC-7730 when CAL filters actually succeeded.

### 3. ERC-7730 lookup hashes the caller’s `types`

CAL can succeed in a unit test and still miss on device if `EIP712Domain` is omitted from `types`. The descriptor hash changes. Mandate injects the canonical domain type in `withExplicitEip712DomainType` without mutating the x402 digest. DMK examples should show both payloads side by side.

### 4. Device presence is not approval of an action

`getAddress` (even with `checkOnDevice`) is not a funding signature. Funding binds `from`, `to`, `value`, `validAfter`, `validBefore`, `nonce` in EIP-3009 typed data. Broker rules (allowed URLs, rolling window, per-call cap) are **not** on the secure screen. We say that in the UI: “Address confirmed. No payment was signed.” then a second step for the allowance tap.

### 5. Key Ring headless vs USB funding

`ring init` needs USB. `ring decrypt` after that does not. Funding still does. Integrators mix those two facts constantly.

Further Key Ring nits we had to encode:

- Decrypt must be **stdin → stdout pipes**. A JSON envelope from `ring decrypt` is a CLI behaviour change; we throw rather than treating `{"ok":true}` as key material.
- Headless Mandate needs `WALLET_PASS` from the OS keychain (`security find-generic-password` / `secret-tool`). Putting the password on the argv would land it in `ps` and shell history.
- Buffer wipe after decrypt is best-effort. Derived JavaScript strings cannot be erased. The skill is right to say: never print decrypt output into an agent transcript.
- The Wallet CLI skill requires `dangerouslyDisableSandbox` for `ring decrypt` because of keychain access. That is not mentioned next to the Key Ring “headless by design” pitch.

### 6. Node HID teardown

`DeviceManagementKit.close()` can hang the Node event loop. We keep a singleton, call `resetDmk()` after every address read and every signature (stop discovering, drop the instance), and never `close()`. That belongs in the Node HID transport docs. DMK errors often arrive as `{ _tag, errorCode }` rather than `Error`; without `formatLedgerError` the UI shows `[object Object]`.

`OpenAppDeviceAction({ appName: "Ethereum" })` is also easy to get wrong when the device is running the CAL-test build. We expose `MANDATE_ETH_APP_OPEN=1` / `skipOpenApp` so the operator can open the correct app first.

### 7. Signature `v`

DMK often returns recovery id `0`/`1`. Circle FiatToken `permit` / authorization paths want `v ∈ {27, 28}`. We normalize once in `joinSignature`. Easy to miss if you copy the signer-kit example as-is.

---

## What we changed in the product because of the above

The spending-allowance dialog now has a three-step checklist:

1. **Clear-signing path** — partner origin token or ledger-dev test CAL (`canClearSign`)
2. **Address confirmed** — read from the device, no payment signed
3. **Allowance signed** — EIP-712 funding on Ledger

Funding still fail-closes if step 1 is missing. That is the “am I ready to fund?” screen the portal does not have.

---

## Specific improvements for Ledger

1. Document CAL **403** as a first-class error: partner `originToken`, or ledger-dev CAL-test, or you are not ERC-7730.
2. One recipe: Key Ring (agent secret) → DMK funding tap → CAL/origin token → software-wallet spend. ETHOnline’s two install commands plus that order.
3. DMK typed-data example with `EIP712Domain` present vs omitted, and the sentence “the descriptor hash changes.”
4. Trace cookbook: `DETECT_BLIND_SIGNING` ≠ blind UI; `SIGN_TYPED_DATA_LEGACY` is the fallback.
5. Node HID: do not call `dmk.close()`; reset the singleton; parse `_tag` errors.
6. Key Ring: pipe decrypt, OS keychain for `WALLET_PASS`, fail if stdout is JSON, USB for init only.
7. Portal search synonyms: `CAL 403`, `origin token`, `wallet-cli ring decrypt headless`, `dmk.close hang`.

## Tutorial we wish existed

**Wire DMK funding for x402 exact USDC on Base**

- EIP-3009 `TransferWithAuthorization` on USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, chain 8453
- Descriptor JSON (we ship one under `docs/erc7730/`)
- One Ledger tap to fund a Key Ring–sealed spending wallet
- Fail closed unless origin token or test CAL is present
- Explicit: broker policy is not on the device screen

## Time-savers

```sh
node scripts/dev/probe-ledger-preflight.mjs   # CAL + optional address; never signs
npm start                                     # no device I/O at boot
```

Default derivation we used: `44'/60'/0'/0/0`.
