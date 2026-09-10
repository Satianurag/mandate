#!/usr/bin/env node
/**
 * Phase 2b: MCP discovery + reputation lookup for an EVM wallet and a Hedera 0.0.x payee.
 * Prints the MCP tool names actually used.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
await ensureWalletPass();

const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
const { lookupCounterparty, getLastMcpToolsUsed } = await import(
  `${ROOT}/packages/gateway/src/reputation.ts`
);
const { discoverAgent0DeploymentsWithKey } = await import(
  `${ROOT}/packages/gateway/src/discovery.ts`
);

const enc = await readFile(`${ROOT}/secrets/graph.enc`);
const apiKey = await withSecret("graph-gateway", enc, (b) =>
  Promise.resolve(b.toString("utf8").trim())
);

const discovered = await discoverAgent0DeploymentsWithKey(apiKey);
console.log("MCP tools used:", discovered.toolsUsed.join(", ") || "(none)");
console.log("discovered deployments:", JSON.stringify(discovered.subgraphs, null, 2));

const evm = process.env.MANDATE_REPUTATION_PROBE ?? "0x79dc34e41b2b591078d3dE222C43EcaaBD52FcCB";
const hedera = process.env.MANDATE_REPUTATION_HEDERA ?? process.env.SERVICE_PAY_TO ?? "0.0.3";

const evmRep = await lookupCounterparty(evm, apiKey);
console.log("evm", evm, JSON.stringify(evmRep, null, 2));
console.log("MCP tools (lookup cache):", getLastMcpToolsUsed().join(", "));

const hRep = await lookupCounterparty(hedera, apiKey, { network: "hedera:testnet" });
console.log("hedera", hedera, JSON.stringify(hRep, null, 2));

if (discovered.toolsUsed.length === 0) {
  console.error("REPUTATION_PROBE_FAILED: MCP used zero tools");
  process.exit(1);
}
if (evmRep.chainsReachable === 0 && hRep.chainsReachable === 0) {
  console.error("REPUTATION_PROBE_FAILED: no subgraphs reachable");
  process.exit(1);
}
console.log("REPUTATION_OK");
await mkdir(`${ROOT}/.live-results`, { recursive: true });
await writeFile(
  `${ROOT}/.live-results/probe-reputation.txt`,
  `REPUTATION_OK tools=${discovered.toolsUsed.join(",")} evmReachable=${evmRep.chainsReachable} hederaReachable=${hRep.chainsReachable}\n`
);
