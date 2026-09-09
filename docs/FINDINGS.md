# Findings log

The single running record of everything we have measured against live systems.
One source of truth — if something here disagrees with another doc, this wins
and the other doc gets fixed.

**Rule: every entry is something we OBSERVED, not something we read.** Where a
measurement contradicts published documentation, the measurement wins and the
plan changes. Re-verify any time with `npm run verify` (26 checks) and
`npm run preflight` (live rails).

| Status | Meaning |
|---|---|
| **RESOLVED** | Answered; design updated accordingly |
| **OPEN** | Still unknown, with a plan to close it |
| **BLOCKING** | Would break the build if not worked around |
| **PROVEN** | A load-bearing claim confirmed on real infrastructure |

---

## Summary

| # | Finding | Status | Date |
|---|---|---|---|
| F1 | The Graph's gateway offers `exact` only — cannot accept batch-settlement | **BLOCKING** → designed around | 08 Sep |
| F2 | `batch-settlement` is live on Base Sepolia via the x402.org facilitator | **RESOLVED** | 08 Sep |
| F3 | Two facilitators advertise two different Hedera fee payers | **RESOLVED** | 08 Sep |
| F4 | The Graph's x402 wire format deviates in three ways | **RESOLVED** | 08 Sep |
| F5 | Blocky402 rejects the payload shape its own spec publishes | **RESOLVED** | 08 Sep |
| F6 | `wallet-cli` JSON-envelopes output over a pipe | **RESOLVED** | 08 Sep |
| F7 | Agent0 subgraphs need a Studio API key — no public route | **RESOLVED** | 08 Sep |
| F8 | The Graph's documented *testnet* x402 gateway does not resolve | **OPEN** (theirs, not ours) | 08 Sep |
| F9 | The fail-safe chain holds under a real dependency failure | **PROVEN** | 08 Sep |
| F10 | `ring init` needs the Ledger Sync device app — undocumented | **RESOLVED** | 08 Sep |
| F11 | Headless seal + decrypt work with the device physically gone | **PROVEN** | 08 Sep |
| F12 | Agent0 has **testnet** deployments — reputation and settlement can share a chain | **RESOLVED** | 08 Sep |
| F13 | A Graph Studio *deploy key* is not a *gateway API key* | **RESOLVED** | 08 Sep |
| F14 | Two Agent0 schema field names were wrong — would have failed at runtime | **RESOLVED** | 08 Sep |
| F15 | First-chain-wins reputation lookup was a **laundering vector** | **RESOLVED** | 08 Sep |
| F16 | All three verdicts reached from live on-chain reputation | **PROVEN** | 08 Sep |
| F17 | 3 of 9 Agent0 deployments fail — silently, until now | **RESOLVED** | 09 Sep |
| F18 | Fail-safe coverage vs. usability — a real tradeoff, undecided | **OPEN** | 09 Sep |

---

## F1 — The Graph's gateway cannot accept batch-settlement · BLOCKING

An earlier revision of the plan said we would "ship batch settlement against
their gateway." **We cannot.** The live 402 advertises exactly one option:

```
scheme  exact          network eip155:8453 (Base MAINNET)
amount  10000          = 0.01 USDC
asset   0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
payTo   0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB
extra   { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" }
```

Batch settlement requires **server-side** support they do not have — which is
exactly why their own forum post asks someone to add it.

**Design change.** The mandate envelope runs on our own service over
`batch-settlement@eip155:84532`. The Graph is integrated via Subgraph MCP,
Agent0 and Substreams, plus one real `exact` payment to their production
gateway as a proof point. Their AI track accepts "Subgraph MCP, Substreams,
**or** x402" — the `or` matters.

## F2 — batch-settlement is live on a public testnet facilitator · RESOLVED

`https://x402.org/facilitator` advertises:

```
batch-settlement@eip155:84532     <- Base Sepolia. The mandate envelope.
upto@eip155:84532                 facilitatorAddress 0xd407e409…f1bf
exact@eip155:84532
exact@hedera:testnet              feePayer 0.0.9185802
```

Better than deploying escrow contracts to Hedera EVM ourselves: public, free,
testnet, no deployment. **The whole demo can be testnet.**

An `upto` scheme sits beside it — semantically very close to a mandate
("authorize up to X"). Worth 30 minutes on Day 1.

## F3 — two facilitators, two different Hedera fee payers · RESOLVED

| Facilitator | Hedera testnet feePayer |
|---|---|
| Blocky402 | `0.0.7162784` |
| x402.org | `0.0.9185802` |

**INVARIANT: never hardcode a fee payer.** Always read it from the live
challenge's `extra`. Hedera's track requires Blocky402 specifically, so the
Hedera-side service uses that one. Enforced in `facilitators.ts`, asserted by
`verify.sh`.

## F4 — The Graph's x402 wire format deviates three ways · RESOLVED

Each would break a naive client, and all three fail quietly:

1. The 402 body is **zero bytes**. Requirements arrive base64-encoded in a
   **`payment-required` response header**.
2. The retry header is **`Payment-Signature`**, not `X-PAYMENT`.
3. The authenticated gateway returns **HTTP 200 with an error body** for auth
   failures. Branching on `res.ok` treats a hard auth failure as success —
   which in our design silently downgrades every counterparty to "unrated".

Handled in `graph.ts` and `reputation.ts`; asserted by `verify.sh`.

## F5 — Blocky402 rejects its own published payload shape · RESOLVED

The scheme markdown wraps requirements in an `accepted` field. The running
facilitator requires `scheme` and `network` at the top level of
`paymentPayload`. Found by probing `/verify` until the validator went quiet:

```
POST /verify {"x402Version":2,"paymentRequirements":{},"paymentPayload":{}}
-> "payload must be an object, scheme should not be empty, scheme must be a
    string, network should not be empty, amount should not be empty, ..."
```

Also: an undecodable transaction returns **HTTP 500**, not a 4xx. Treat every
non-2xx as terminal — retrying a settle of unknown outcome risks paying twice.
`types.ts` matches the running server; `hedera.ts` never retries.

## F6 — `wallet-cli` JSON-envelopes output over a pipe · RESOLVED

v2.1.0 wraps output as `{"ok":true,"data":…}` / `{"ok":false,"error":{…}}` when
stdout is not a TTY — which is how Node spawns it. Exit codes are correct
(1 on failure), but `ring keys` output is JSON, not lines.

**The sharp question was `ring decrypt`.** Returning `{"ok":true,…}` as if it
were key material would fail far downstream with an unreadable error.

**Measured on a provisioned device: `ring decrypt` returns RAW PLAINTEXT.**
No unwrapping needed. The guard in `keyring.ts` stays as a safety net but will
not fire.

## F7 — Agent0 needs a Studio API key · RESOLVED

Both `api.thegraph.com` and the gateway refuse without one; there is no public
route. A Studio gateway key is a hard dependency for reputation lookups. Seal
it in the Key Ring:

```bash
printf '%s' "$KEY" | wallet-cli ring encrypt --key graph-gateway > secrets/graph.enc
```

## F8 — The Graph's testnet x402 gateway does not resolve · OPEN

`@graphprotocol/client-x402`'s README documents:

| Environment | Gateway | Network |
|---|---|---|
| production | `gateway.thegraph.com/api/x402` | base |
| testnet | `testnet.gateway.thegraph.com/api/x402` | base-sepolia |

The testnet host is **NXDOMAIN**. Documented, not deployed. We do not need it —
the envelope runs on Base Sepolia and their track accepts MCP or Substreams —
but do not build a demo path assuming it appears. Good DX report for them.
`preflight` re-checks it each run in case it lands.

## F9 — The fail-safe chain holds under a real failure · PROVEN

Live 402 from our own service through the real policy engine, with **no Graph
API key and no device**:

```
service responded: 402
normalised: 0.037 HBAR  (from 3700000 tinybars)
verdict : DENY
trace   : budget:spent=0.0000/5 -> reputation:unregistered
```

Reputation lookup failed → counterparty treated as **unregistered**, not
trusted → escalate → no device → **deny**. A missing dependency never produced
an `allow`. Locked in as `e2e.test.ts`, so a change that makes the system fail
*open* breaks the build.

## F10 — `ring init` needs the Ledger Sync device app · RESOLVED

Undocumented and blocking for a first-time user. The docs give one instruction
— *"Run `ring init` once to provision the key ring via the device"* — and never
mention a prerequisite app. On a device without it:

```
$ wallet-cli ring init --name mandate-host
Generating member credentials…
Connect device, open Ledger Sync app — provisioning your Ledger Key Ring…
[✖] An unknown error occurred talking to the Ledger.
```

Ledger Live installs that app automatically when you enable Ledger Sync;
**wallet-cli does neither** — no install, no prompt, and the failure surfaces
as "An unknown error". Cost ~35 minutes, most of it suspecting USB and the lock
state. Written up as **DX friction #03** with three proposed fixes.

**The sequence that works:**

1. Ledger Wallet app → Settings → Ledger Sync → on *(installs the device app)*
2. **Quit the Ledger Wallet app** — it holds USB and blocks wallet-cli
3. Open the **Ledger Sync** app on the device
4. `wallet-cli ring init`

## F11 — Headless seal and decrypt, device disconnected · PROVEN

**The load-bearing claim of the entire Ledger track.** With the Ledger
physically unplugged (`system_profiler SPUSBDataType` reports zero Ledger USB
entries; `genuine-check` times out):

```
run 1: OK  (76 bytes sealed, exact match)
run 2: OK  (76 bytes sealed, exact match)
run 3: OK  (76 bytes sealed, exact match)
```

Both `ring encrypt` **and** `ring decrypt` work with no device attached —
stronger than required, since only decrypt was needed. Provision once with the
device, then seal and open freely on a VPS or CI runner.

Satisfies Ledger's own listed hacking direction verbatim: *"Key Ring deployment
to non-USB environments (VPS, CI runners, hosted agents)."* The demo can run
from a host that has never seen the hardware.

## F12 — Agent0 runs on testnets too · RESOLVED

The two IDs originally hardcoded (Base, BSC mainnet) were correct. But the docs
also list **testnet** deployments, and one of them changes the design:

| Network | Chain | Subgraph ID |
|---|---|---|
| **Base Sepolia** | 84532 | `4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u` |
| Ethereum Sepolia | 11155111 | `6wQRC7geo9XYAhckfmfo8kbMRLeWU8KQd3XsJqFKmZLT` |
| BSC Chapel | 97 | `BTjind17gmRZ6YhT9peaCM13SvWuqztsmqyfjpntbg3Z` |
| Monad Testnet | 10143 | `8iiMH9sj471jbp7AwUuuyBXvPJqCEsobuHBeUEKQSxhU` |

**Base Sepolia is where the mandate escrow channel lives.** So reputation and
settlement can sit on the same chain, instead of reading *mainnet* reputation
to authorise a *testnet* payment — which never really made sense and would have
been an awkward question in judging. `reputation.ts` now queries testnet first,
with mainnet as fallback so a counterparty registered only on mainnet is still
recognised.

Useful schema details confirmed at the same time:

- **Feedback score is 0–100** — the `/100` normalisation in `reputation.ts` is correct
- `AgentRegistrationFile` carries **`x402` support**, MCP endpoint/tools, A2A
  skills and trust models — richer counterparty signal than assumed
- One schema is shared across all deployments, so the same query works on every
  chain; only the endpoint changes

**Still to verify once a working key exists:** the exact field names in our
query (`agents(where: {agentWallet: …})`, `feedbacks`, `validations`).

## F13 — a Studio *deploy key* is not a gateway *API key* · OPEN

Both are 32-hex strings and both live in Subgraph Studio, so they are easy to
confuse. Symptom, with a correctly-shaped but wrong key:

```
path-based /api/<key>/…   -> {"errors":[{"message":"auth error: API key not found"}]}
Authorization: Bearer …   -> {"errors":[{"message":"auth error: API key not found"}]}
X-Api-Key / raw header    -> {"errors":[{"message":"auth error: missing authorization header"}]}
```

The distinction is diagnostic: *"API key not found"* means the format parsed
and the key is simply unknown; *"missing authorization header"* means the auth
scheme itself was not recognised. Retried after 45s to rule out propagation.

- **Deploy key** — on the subgraph/dashboard page, used with `graph auth` to publish
- **API key** — Studio → **API Keys** tab → **Create API Key**, used for querying

Only the second one works against the gateway.

## F14 — two Agent0 field names were wrong · RESOLVED

Schema introspection against the live subgraph caught two names that would have
failed at runtime:

| Draft | Actual |
|---|---|
| `feedbacks` | **`feedback`** (singular) |
| `revoked` | **`isRevoked`** |

Also confirmed: `value` is a `BigDecimal`, `agentWallet` is **nullable** (real
agents exist with no wallet), and `Validation` carries `response` plus a
`status` enum. Fixed in `reputation.ts`.

Sampling note: `first: 100` reads the most recent feedback rather than all of
it — the busiest agent on Base carries **312,558** entries. A recency-weighted
sample is also the more honest signal: an agent that behaved well two years ago
and badly last week should not average out to fine.

## F15 — first-chain-wins reputation was a laundering vector · RESOLVED

The original lookup returned the first chain where an agent was registered.
Live data shows why that is unsafe. Wallet `0xf9d1d63f…d5f1` is registered on
**both**:

```
ethereum   FOUND  live_feedback=0
base       FOUND  live_feedback=100
```

First-wins picked Ethereum and reported a well-rated agent as **unrated** —
which in our policy means `step_up` instead of `allow`. The dangerous direction
is the mirror image: **an agent with bad history on one chain need only
register on a quiet one to look clean.**

Fixed by POOLING every entry across every deployment. Adding a fresh empty
registration can no longer dilute an existing bad record — it contributes zero
entries to the pool. Revocations are summed across chains for the same reason.
The resolved chain is now reported as a set (`base+ethereum`) rather than one
name.

## F16 — all three verdicts reached from live on-chain reputation · PROVEN

Real ERC-8004 counterparties on Base and Ethereum, through the real policy
engine, at 0.05 HBAR per call:

```
wallet          chains                score  fb   verdict
0xf9d1d63f362b… base+ethereum         0.98   100  ALLOW
0x7346dc42102b… base                  0.51   11   STEP_UP
0x729a121c347c… base                  0.99   100  ALLOW
0x715dc035ffb9… base                  0.53   3    STEP_UP
0xcc28cee3a143… base+ethereum         0.92   85   ALLOW
0xb0b7f42e6686… base                  0.05   1    DENY
0xe84ff92197c4… base+ethereum         0.92   100  ALLOW
0xc1c60b1620d7… base                  0.01   100  DENY
0x0000000000dEaD  -                   -      0    STEP_UP

allow=4  step_up=3  deny=2
```

**Nothing here is mocked.** Every score is live indexed data, and the demo can
name real counterparties rather than invented ones. Keep these wallets — they
give the video a clean allow / step-up / deny sequence with no staging.

## F17 — 3 of 9 Agent0 deployments fail, and were failing silently · RESOLVED

Prompted by the question "why are we only looking up 2 chains?" The premise was
off — all 9 were queried, `base+ethereum` was just where those wallets were
*found* — but the instinct was right and exposed something worse.

Measured, with one retry each:

```
base-sepolia        ok    head=46562052
ethereum-sepolia    FAIL  bad indexers: {0xf92f430dd8567b0d466358c…}
bsc-chapel          ok    head=129879711
monad-testnet       FAIL  bad indexers: {0xbdfb5ee5a2abf4fc7bb1bd1…}
ethereum            ok    head=25934458
base                ok    head=51051524
bsc                 ok    head=120734955
polygon             ok    head=93458242
monad               FAIL  bad indexers: {0xbdfb5ee5a2abf4fc7bb1bd1…}

reachable: 6/9   failing: 3/9
```

`Promise.allSettled` plus a `.filter(fulfilled && non-null)` was **dropping all
three silently**. Same laundering vector as F15, different door: an agent with
bad Monad history looks clean because Monad never answered.

Two fixes:

1. **`queryAgent` now throws** on a gateway error instead of returning `null`,
   so "no such agent here" is distinguishable from "this registry did not
   answer". Collapsing those two is what created the hole.
2. **Coverage travels with the reputation record** — `chainsQueried`,
   `chainsReachable`, `chainsFailed` — and reaches the policy engine, which
   escalates above a trivial amount. An unread registry can only hide
   *negative* signal; nobody launders a good reputation.

## F18 — fail-safe coverage vs. usability · OPEN, needs a decision

The F17 fix is correct and immediately inconvenient. Live re-run:

```
0xf9d1d63f362b…  coverage 6/9  0.98  STEP_UP  unread: ethereum-sepolia,monad,monad-testnet
0x729a121c347c…  coverage 6/9  0.99  STEP_UP  unread: ethereum-sepolia,monad,monad-testnet
```

**Everything above 0.02 now escalates**, because those three deployments appear
persistently unindexed rather than briefly down. Strictly safe, practically
unusable — and it would flatten the demo, since the `allow` path would never
appear.

Three options, none free:

| Option | Cost |
|---|---|
| **A. Drop the broken chains from the registry** | Honest only if we say so. An agent registered *only* on Monad becomes invisible, which is exactly the hole F15/F17 closed. Acceptable if the chain set is explicit and the audit record names it. |
| **B. Keep the escalation, raise `trivialAmount`** | Preserves the property; picks an arbitrary line. |
| **C. Weight by coverage instead of gating** | Most defensible, most work: treat a score from 6/9 registries as weaker evidence rather than a blocker. |

### Option C simulated against the real wallets

Bayesian shrinkage toward a pessimistic prior, weighted by missing coverage:

```
coverage  = chainsReachable / chainsQueried            6/9 = 0.67
k         = K_MAX * (1 - coverage)                     pseudo-observations
effective = (score*n + PRIOR*k) / (n + k)              PRIOR = 0.35, K_MAX = 40
```

| wallet | n | raw | gating (B) | weighted | verdict (C) |
|---|---|---|---|---|---|
| 0xf9d1d63f… | 100 | 0.98 | STEP_UP | 0.90 | **ALLOW** |
| 0x7346dc42… | 11 | 0.51 | STEP_UP | 0.42 | STEP_UP |
| 0x729a121c… | 100 | 0.99 | STEP_UP | 0.92 | **ALLOW** |
| 0x715dc035… | 3 | 0.53 | STEP_UP | 0.38 | STEP_UP |
| 0xcc28cee3… | 85 | 0.92 | STEP_UP | 0.84 | **ALLOW** |
| 0xb0b7f42e… | 1 | 0.05 | STEP_UP | 0.33 | **DENY** |
| 0xe84ff921… | 100 | 0.92 | STEP_UP | 0.85 | **ALLOW** |
| 0xc1c60b16… | 100 | 0.01 | STEP_UP | 0.05 | **DENY** |

```
gating  (B): allow=0  step_up=8  deny=0
weighted(C): allow=4  step_up=2  deny=2
```

**Bonus property.** `0xb0b7f42e` is raw 0.05 from a single review; weighting
pulls it *up* to 0.33 because one bad review is not proof. It still denies, but
for a defensible reason. That makes `minFeedbackForTrust` redundant — thin
history and missing coverage are the same problem ("not enough evidence") and
one mechanism handles both.

**The honest catch.** C is genuinely WEAKER than B. At n=100 the prior barely
moves the score, so an agent with 100 glowing reviews on Base and catastrophic
history on unreadable Monad still gets ALLOW. Large samples swamp the
correction. C buys usability by accepting a real hole.

It also introduces two magic numbers (`PRIOR`, `K_MAX`) that need justifying,
and is harder to explain in a demo than "we escalate when we cannot see
everything."

### Current recommendation: hybrid

Weight the score for ordinary traffic, **and keep a hard gate above a
meaningful amount**. Small payments flow on discounted evidence; anything that
actually matters still needs a human while registries are dark. C's usability,
B's guarantee where it counts, one sentence to a judge.

Still not decided — and specifically, do not let it get settled by whatever
makes the demo look best.

---

## Still open

| Item | When | Load-bearing? |
|---|---|---|
| DMK device session over WebHID | Day 3 | No — browser-side |
| ERC-7730 v2 rendering on the trusted display | Day 3 | No |
| `upto` scheme — may map to a mandate more directly than batch-settlement | Day 1 spike | No |
| Graph Studio API key | Day 1 | Yes — nothing reputation-related works without it |

## How to add a finding

Append to the summary table and add a section. Keep the format: what we
expected, what we observed (with the actual output), what it cost, and what
changed as a result. A finding without evidence is an opinion.

Cross-references: `DX.md` holds the sponsor-facing write-ups (Ledger judges
those equally with code); this file holds everything, sponsor-facing or not.
