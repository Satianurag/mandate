#!/usr/bin/env node
/**
 * Preflight probe: unseal the Graph gateway key in-process and verify one
 * Agent0 deployment answers. The key never touches argv, env, or disk —
 * withSecret keeps it in a locked Buffer that is wiped after use.
 *
 * Exit 0: reachable. Exit 1: key rejected / unreachable / unseal failed.
 */
import { readFile } from "node:fs/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);

// Base Agent0 deployment (chain 8453) — any reachable one proves the key.
const DEPLOYMENT = "DQeZgv6z9hjopmzihqjiAprLE8mkV6hTakenC2eR2u";

const enc = await readFile(`${ROOT}/secrets/graph.enc`).catch(() => null);
if (!enc) {
  console.error("secrets/graph.enc missing — run npm run seal:keys");
  process.exit(1);
}

try {
  await withSecret("graph-gateway", enc, async (key) => {
    const res = await fetch(
      `https://gateway.thegraph.com/api/subgraphs/id/${DEPLOYMENT}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key.toString("utf8").trim()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "{_meta{block{number}}}" }),
      }
    );
    const body = await res.text();
    // NOTE: the gateway returns HTTP 200 even for auth errors — inspect the body.
    if (body.includes('"errors"')) {
      throw new Error(`key rejected: ${body.slice(0, 120)}`);
    }
    console.log("Agent0 subgraph reachable with sealed key");
  });
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
