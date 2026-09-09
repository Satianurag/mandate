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

<!-- Entries 04+ land as they happen. Do not batch these on Saturday. -->
