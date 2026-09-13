# AI use (ETHOnline 2026)

Mandate was built in Cursor during ETHOnline 2026. AI assisted implementation, DX writing, and tests. Humans directed product rules: Ledger never leaks secrets to the model, funding is an explicit device tap, Graph data must be live, Hedera live HCS stays gated.

## Tools

- Cursor (agent) for TypeScript, operator UI, tests, and this submission pack
- Ledger Agent Stack skills (`npx skills add ledgerhq/agent-skills`) as the DMK / Wallet CLI reference, copied under `agent/skills/` and `.claude/skills/`

## Where assistance landed

- Operator workspace: `packages/gateway/src/**`, `console/workspace.html`, `console/workspace.css`, `console/agents.js`, `console/setup.js`
- Ledger adapters: `dmksigner.ts`, `keyring.ts`, `origin-token.ts`, `agent-funding.ts`
- Graph / Hedera rails and tests beside those modules
- Docs: `README.md`, `DX.md`, this file

No spec-kit / OpenSpec prompt tree is in this repo. There is no generated-only surface that a teammate did not review.
