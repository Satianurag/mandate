#!/usr/bin/env node
/** Probe Agent0 subgraph IDs + live reputation lookup (needs secrets/graph.enc). */
import { readFile } from "node:fs/promises";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
await ensureWalletPass();

const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
const { lookupCounterparty, AGENT0_SUBGRAPHS } = await import(
  `${ROOT}/packages/gateway/src/reputation.ts`
);

const enc = await readFile(`${ROOT}/secrets/graph.enc`);
const apiKey = await withSecret("graph-gateway", enc, (b) =>
  Promise.resolve(b.toString("utf8").trim())
);

console.log(`Agent0 deployments: ${Object.keys(AGENT0_SUBGRAPHS).length}`);

// Known registered agent wallet from live Base subgraph sampling (2026-09-08 docs).
const probe = process.env.MANDATE_REPUTATION_PROBE ?? "0x79dc34e41b2b591078d3dE222C43EcaaBD52FcCB";

const rep = await lookupCounterparty(probe, apiKey);
console.log(JSON.stringify(rep, null, 2));

if (rep.chainsReachable === 0) {
  console.error("REPUTATION_PROBE_FAILED: no subgraphs reachable");
  process.exit(1);
}
console.log("REPUTATION_OK");
