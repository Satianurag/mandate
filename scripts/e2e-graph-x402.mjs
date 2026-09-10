#!/usr/bin/env node
/**
 * Phase 2a E2E: Graph testnet x402.
 * Probes the documented host first. On NXDOMAIN/F8, prints a FINDING and
 * exits 2 — never pays mainnet USDC (F31) and never fakes a settlement id.
 */
import { writeFile } from "node:fs/promises";
import { GRAPH_X402_TESTNET } from "../packages/gateway/src/graph.ts";
import { probeGraphX402Testnet } from "../packages/gateway/src/graph-x402.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const subgraph =
  process.env.MANDATE_GRAPH_X402_SUBGRAPH ?? "4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u";

const probe = await probeGraphX402Testnet(subgraph);
const line = JSON.stringify({ gateway: GRAPH_X402_TESTNET, subgraph, ...probe }, null, 2);
console.log(line);
await writeFile(`${ROOT}/.live-results/e2e-graph-x402.txt`, line + "\n").catch(() => {});

if (!probe.ok) {
  console.error("FINDING F8: Graph x402 testnet is not a live rail. No stub, no mainnet fallback.");
  process.exit(2);
}
console.log("GRAPH_X402_TESTNET_OK");
