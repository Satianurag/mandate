#!/usr/bin/env node
/**
 * Hashio JSON-RPC adapter (transport only — no bytecode changes).
 *
 * Hedera JSON-RPC docs use QUANTITY|TAG for historical methods
 * (`"latest"` or `"0x<blockNumber>"`):
 * https://github.com/hashgraph/hedera-docs/blob/main/evm/differences/json-rpc-differences.mdx
 *
 * Ethereum JSON-RPC `eth_getCode` param 2 is QUANTITY|TAG, not a block hash:
 * https://ethereum.org/en/developers/docs/apis/json-rpc/#eth_getcode
 *
 * Foundry still sends a 32-byte hash (Hashio's own `block.hash`) as that tag.
 * Hashio then returns -39012. Map QUANTITY|TAG slots to a documented tag.
 *
 * Usage: node scripts/hashio-rpc-proxy.mjs [listenPort]
 * Upstream: HEDERA_EVM_RPC_URL or https://testnet.hashio.io/api
 */
import { createServer } from "node:http";

const UPSTREAM = process.env.HEDERA_EVM_RPC_URL ?? "https://testnet.hashio.io/api";
const PORT = Number(process.argv[2] ?? process.env.HASHIO_PROXY_PORT ?? 8549);
const HASH32 = /^0x[0-9a-fA-F]{64}$/;
const NAMED_TAGS = new Set(["latest", "earliest", "pending", "safe", "finalized"]);

function asQuantityTag(value) {
  if (value == null) return "latest";
  if (typeof value === "object") {
    if (typeof value.blockNumber === "string" || typeof value.blockNumber === "number") {
      return asQuantityTag(value.blockNumber);
    }
    if (typeof value.blockTag === "string") return asQuantityTag(value.blockTag);
    return "latest";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `0x${Math.trunc(value).toString(16)}`;
  }
  if (typeof value === "string") {
    if (NAMED_TAGS.has(value)) return value;
    if (HASH32.test(value)) return "latest";
    return value;
  }
  return "latest";
}

const QUANTITY_TAG_INDEX = {
  eth_call: 1,
  eth_estimateGas: 1,
  eth_getCode: 1,
  eth_getBalance: 1,
  eth_getTransactionCount: 1,
  eth_getStorageAt: 2,
  eth_getProof: 2,
  eth_getBlockByNumber: 0,
};

function rewrite(body) {
  const msgs = Array.isArray(body) ? body : [body];
  for (const msg of msgs) {
    if (!msg || typeof msg !== "object") continue;
    const method = String(msg.method ?? "");
    const params = Array.isArray(msg.params) ? msg.params : [];
    const idx = QUANTITY_TAG_INDEX[method];
    if (idx != null && params.length > idx) {
      params[idx] = asQuantityTag(params[idx]);
    }
    msg.params = params;
  }
  return Array.isArray(body) ? msgs : msgs[0];
}

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" } }));
    return;
  }
  const forwarded = rewrite(parsed);
  try {
    const up = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forwarded),
    });
    const text = await up.text();
    if (up.status >= 400) {
      const method =
        forwarded?.method ??
        (Array.isArray(forwarded) ? forwarded.map((m) => m.method).join(",") : "?");
      const params =
        forwarded?.params ?? (Array.isArray(forwarded) ? forwarded.map((m) => m.params) : []);
      console.error(
        "hashio upstream",
        up.status,
        method,
        JSON.stringify(params).slice(0, 400),
        text.slice(0, 300)
      );
    }
    res.writeHead(up.status, { "content-type": "application/json" });
    res.end(text);
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: e instanceof Error ? e.message : String(e) },
      })
    );
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`hashio-rpc-proxy 127.0.0.1:${PORT} → ${UPSTREAM}`);
});
