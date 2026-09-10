#!/usr/bin/env node
/**
 * Live allow / step_up / deny from Agent0 + the policy engine. No device.
 * Wallets are the F16 demo set (full addresses from the 8 Sep measurement).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
await ensureWalletPass();

const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
const { lookupCounterparty } = await import(`${ROOT}/packages/gateway/src/reputation.ts`);
const { PolicyEngine } = await import(`${ROOT}/packages/gateway/src/policy.ts`);

const WALLETS = {
  allow: "0xf9d1d63f362bbf1ee08ab9acb36fe74afc48d5f1",
  step_up: "0x7346dc42102b5cdba321d587564612d1f3878ad2",
  deny: "0xc1c60b1620d7017221f2710e3ea4bb7ce86857b2",
};

const enc = await readFile(`${ROOT}/secrets/graph.enc`);
const apiKey = await withSecret("graph-gateway", enc, (b) =>
  Promise.resolve(b.toString("utf8").trim())
);

const engine = new PolicyEngine();
const proposal = (payTo) => ({
  origin: "https://agent0.live",
  requirements: {
    scheme: "exact",
    network: "hedera:testnet",
    asset: "0.0.0",
    amount: "5000000",
    payTo,
    maxTimeoutSeconds: 60,
    extra: { feePayer: "0.0.7162784" },
  },
  normalisedAmount: 0.05,
  assetSymbol: "HBAR",
});

const rows = [];
for (const [want, wallet] of Object.entries(WALLETS)) {
  const rep = await lookupCounterparty(wallet, apiKey);
  const d = engine.evaluate(proposal(wallet), rep);
  const line = `${wallet} want=${want} got=${d.verdict} score=${rep.meanScore ?? "-"} fb=${rep.feedbackCount} cov=${rep.chainsReachable}/${rep.chainsQueried}`;
  console.log(line);
  console.log(`  ${d.reason}`);
  rows.push({ want, wallet, got: d.verdict, reason: d.reason, score: rep.meanScore, fb: rep.feedbackCount });
}

const seen = new Set(rows.map((r) => r.got));
const ok = seen.has("allow") && seen.has("step_up") && seen.has("deny");
await mkdir(`${ROOT}/.live-results`, { recursive: true });
await writeFile(
  `${ROOT}/.live-results/e2e-verdicts.txt`,
  rows.map((r) => `${r.got}\t${r.wallet}\t${r.score}\t${r.fb}\n`).join("") +
    (ok ? "VERDICTS_OK allow+step_up+deny\n" : "VERDICTS_PARTIAL\n")
);
if (!ok) {
  console.error(`VERDICTS_PARTIAL seen=${[...seen].join(",")}`);
  process.exit(1);
}
console.log("VERDICTS_OK allow+step_up+deny from live Agent0");
