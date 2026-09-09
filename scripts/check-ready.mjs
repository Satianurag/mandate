#!/usr/bin/env node
/**
 * Preflight for live payment scripts — exits 0 when ready, 1 with checklist otherwise.
 */

import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { constants } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const missing = [];

async function exists(p) {
  try {
    await access(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function keychainPass() {
  return new Promise((resolve) => {
    const c = spawn("security", [
      "find-generic-password",
      "-a",
      "default",
      "-s",
      "ledger-wallet-cli",
      "-w",
    ]);
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", (code) => resolve(code === 0 ? out.trim() : ""));
  });
}

if (!(await exists(`${ROOT}/secrets/graph.enc`))) missing.push("secrets/graph.enc (npm run seal:keys)");
if (!(await exists(`${ROOT}/secrets/hedera.enc`))) missing.push("secrets/hedera.enc (npm run seal:keys)");
if (!process.env.MANDATE_HEDERA_ACCOUNT_ID) missing.push("MANDATE_HEDERA_ACCOUNT_ID");

const pass = await keychainPass();
if (!pass && !process.env.WALLET_PASS) missing.push("WALLET_PASS / Keychain entry for wallet-cli");

if (missing.length) {
  console.error("Not ready for npm run e2e:payment:");
  for (const m of missing) console.error("  -", m);
  process.exit(1);
}

console.log("READY for npm run e2e:payment");
console.log("  Optional: export SERVICE_PAY_TO=$MANDATE_HEDERA_ACCOUNT_ID");
