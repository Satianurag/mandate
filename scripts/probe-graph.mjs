#!/usr/bin/env node
/**
 * Preflight probe: unseal the Graph gateway key in-process and verify one
 * Agent0 deployment answers. The key never touches argv, env, or disk —
 * withSecret keeps it in a locked Buffer that is wiped after use.
 *
 * Exit 0: reachable. Exit 1: key rejected / unreachable / unseal failed.
 *
 * Subgraph IDs move (plan Day 3). Do not pin a deployment here — discover
 * via Subgraph MCP, then query `_meta` on the first id.
 */
import { readFile } from "node:fs/promises";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
await ensureWalletPass();
const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);

const enc = await readFile(`${ROOT}/secrets/graph.enc`).catch(() => null);
if (!enc) {
  console.error("secrets/graph.enc missing — run npm run seal:keys");
  process.exit(1);
}

try {
  await withSecret("graph-gateway", enc, async (key) => {
    const apiKey = key.toString("utf8").trim();
    const { discoverAgent0DeploymentsWithKey } = await import(
      `${ROOT}/packages/gateway/src/discovery.ts`
    );
    const { subgraphs, toolsUsed } = await discoverAgent0DeploymentsWithKey(apiKey);
    const ids = [...new Set(Object.values(subgraphs))];
    if (ids.length === 0) throw new Error("Subgraph MCP returned no Agent0 ids");
    let last = "";
    for (const id of ids) {
      const res = await fetch(`https://gateway.thegraph.com/api/subgraphs/id/${id}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "{_meta{block{number}}}" }),
      });
      const body = await res.text();
      last = body.slice(0, 160);
      if (/unauthorized|forbidden|invalid api key/i.test(body)) {
        throw new Error(`key rejected: ${last}`);
      }
      if (body.includes("subgraph not found")) continue;
      if (body.includes('"errors"')) continue;
      console.log(
        `Agent0 subgraph reachable with sealed key (mcp=${toolsUsed.join(",") || "none"} id=${id.slice(0, 8)}…)`
      );
      return;
    }
    throw new Error(
      `sealed key accepted but 0/${ids.length} Agent0 ids answered (${last})`
    );
  });
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
