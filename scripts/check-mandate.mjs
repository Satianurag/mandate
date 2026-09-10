#!/usr/bin/env node
/**
 * Preflight for npm run mandate:open — exits 0 when ready, 1 with checklist.
 * Static checks (files, config, RPC chain) plus a live device probe.
 */

import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

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

await ensureWalletPass();
if (!process.env.WALLET_PASS) missing.push("WALLET_PASS (npm run device)");

let rpcUrl = process.env.MANDATE_EVM_RPC_URL;
if (!(await exists(FILE))) missing.push(`${FILE} (copy mandate.example.yaml → mandate.yaml)`);
else {
  const { parseMandateFile } = await import(`${ROOT}/packages/gateway/src/mandate-config.ts`);
  try {
    const mf = parseMandateFile(await readFile(FILE, "utf8"));
    if (/^0x0+$/.test(mf.salt)) missing.push("mandate.yaml salt is zero — generate a fresh bytes32");
    if (/^0x0+$/.test(mf.receiver)) missing.push("mandate.yaml receiver is zero — set an address you control");
    rpcUrl ??= mf.rpcUrl;
  } catch (e) {
    missing.push(`mandate.yaml invalid: ${e instanceof Error ? e.message : e}`);
  }
}
if (rpcUrl) process.env.MANDATE_EVM_RPC_URL = rpcUrl;

for (const f of ["mandate-session", "mandate-facilitator", "mandate-authorizer"]) {
  if (!(await exists(`${ROOT}/secrets/${f}.enc`))) {
    missing.push(`secrets/${f}.enc (npm run ${f === "mandate-session" ? "mandate" : "facilitator"}:keygen)`);
  }
}

if (!rpcUrl) {
  missing.push("MANDATE_EVM_RPC_URL (or mandate.yaml rpcUrl)");
} else {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const chain = parseInt((await res.json()).result, 16);
    if (chain !== 84532) missing.push(`RPC chain is ${chain}, want 84532`);
  } catch (e) {
    missing.push(`RPC unreachable (${e instanceof Error ? e.message : e})`);
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
  const signer = await DmkEvmSigner.create({
    timeoutMs: Number(process.env.MANDATE_DEVICE_PROBE_MS ?? 20_000),
  });
  console.log(`READY for npm run mandate:open (payer ${signer.address})`);
  // DMK HID keep-alive can pin the Node event loop after close().
  process.exit(0);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`Device probe failed: ${msg}`);
  if (/6901|Unexpected device exchange|locked/i.test(msg)) {
    console.error(
      "Nano is on USB but not answering APDUs — enter PIN, keep the device awake, quit Ledger Wallet desktop, open the Ethereum app."
    );
  } else {
    console.error("Attach + unlock the Ledger and open the Ethereum app, then re-run.");
  }
  process.exit(1);
}
