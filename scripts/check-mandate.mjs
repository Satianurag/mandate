#!/usr/bin/env node
/**
 * Preflight for npm run mandate:open — exits 0 when ready, 1 with checklist.
 * Static checks (files, config, RPC chain) plus a live device probe.
 */

import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const FILE = process.env.MANDATE_FILE ?? `${ROOT}/mandate.yaml`;
const missing = [];

async function exists(p) {
  try {
    await access(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(FILE))) missing.push(`${FILE} (copy mandate.example.yaml → mandate.yaml)`);
else {
  const { parseMandateFile } = await import(`${ROOT}/packages/gateway/src/mandate-config.ts`);
  try {
    const mf = parseMandateFile(await readFile(FILE, "utf8"));
    if (/^0x0+$/.test(mf.salt)) missing.push("mandate.yaml salt is zero — generate a fresh bytes32");
    if (/^0x0+$/.test(mf.receiver)) missing.push("mandate.yaml receiver is zero — set an address you control");
  } catch (e) {
    missing.push(`mandate.yaml invalid: ${e instanceof Error ? e.message : e}`);
  }
}
for (const f of ["mandate-session", "mandate-facilitator", "mandate-authorizer"]) {
  if (!(await exists(`${ROOT}/secrets/${f}.enc`))) {
    missing.push(`secrets/${f}.enc (npm run ${f === "mandate-session" ? "mandate" : "facilitator"}:keygen)`);
  }
}
if (!process.env.WALLET_PASS) missing.push("WALLET_PASS (npm run device)");

if (!process.env.MANDATE_EVM_RPC_URL) {
  missing.push("MANDATE_EVM_RPC_URL");
} else {
  try {
    const res = await fetch(process.env.MANDATE_EVM_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const chain = parseInt((await res.json()).result, 16);
    if (chain !== 84532) missing.push(`MANDATE_EVM_RPC_URL chain is ${chain}, want 84532`);
  } catch (e) {
    missing.push(`MANDATE_EVM_RPC_URL unreachable (${e instanceof Error ? e.message : e})`);
  }
}

if (missing.length) {
  console.error("Not ready for npm run mandate:open:");
  for (const m of missing) console.error("  -", m);
  process.exit(1);
}

// Live device probe (read-only address resolution, no tap).
const { DmkEvmSigner } = await import(`${ROOT}/packages/gateway/src/dmksigner.ts`);
try {
  const signer = await DmkEvmSigner.create({ timeoutMs: 8000 });
  console.log(`READY for npm run mandate:open (payer ${signer.address})`);
} catch (e) {
  console.error(`Device probe failed: ${e instanceof Error ? e.message : e}`);
  console.error("Attach + unlock the Ledger and open the Ethereum app, then re-run.");
  process.exit(1);
}
