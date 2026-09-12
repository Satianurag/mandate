# Mandate

An autonomous x402 workspace with Ledger-approved spending on **Base mainnet** (chain 8453), using native USDC. One frontend, one local application, one port.

## Open

Use Node 22.13 or newer:

```sh
npm ci
npm start
# In another terminal, optionally:
npm run console:open
```

Open http://127.0.0.1:8410/. The workspace opens directly and creates an authenticated local session. There is no landing page, terminal-command gate or second frontend. Startup does not unlock a wallet, sign or spend. The boot/console/gateway/agents:boot aliases all use the same entry point; a second process refuses to start on an occupied port.

## Configure

1. **Settings:** use your gcloud project with Gemini 3.5 Flash (HIGH thinking, 65,536 output tokens), Base mainnet RPC, an x402 v2 exact facilitator and your existing Ledger Key Ring key. Google application credentials must already be available on this host. Model usage is billed separately by Google.
2. Tool selection is autonomous. Wallet preparation checks unpaid offers and pins the approved endpoints, recipients and limits. The agent chooses useful tools within that Ledger-approved scope.
3. **Ledger budget:** enter or read your public Ledger address, set the total, per-call and rolling limits, and prepare an encrypted spending wallet. Drafts can be saved before an address is available. Preparation requires a provisioned Key Ring; it does not fund the wallet.
4. Review and explicitly fund the displayed allowance on Ledger. Funding must settle before agents become ready.
5. **New task:** choose an agent, describe the outcome, review its proposed steps and quoted cost, then start. Run details, receipts and settings have separate views.

The software spending wallet executes approved x402 requests without asking Ledger for each call. Ledger approves initial funding and explicit increases. The broker enforces scope, expiry and spending limits; those policies are not hardware-enforced. Return unused funds through the Ledger budget page.

## Architecture and status

The engine adapts the reference project's planning, unpaid estimates, approval, paid-step execution, durable checkpoints and evidence-based reporting to Mandate's Vertex model, SQLite journal and Ledger Key Ring. See [implementation mapping](docs/AGENT-WORKSPACE.md).

The current implementation is mainnet-only. Old testnet keys and state are not migrated into spending authority. Historical proof documents under `docs/verification` describe retired testnet runs and do **not** verify this mainnet release. Actual Ledger funding, vendor settlement and the configured model still require live acceptance with the user's address, funded account and credentials. No live mainnet payment has been claimed or authorized by this migration.

The latest instruction pauses test writing and execution. Earlier fixture results predate the final integration changes and are not a current all-tests-passing claim.
