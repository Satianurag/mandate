#!/usr/bin/env node
/**
 * Preflight for live payment scripts — exits 0 when ready, 1 with checklist otherwise.
 */

import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

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

if (!(await exists(`${ROOT}/secrets/graph.enc`))) missing.push("secrets/graph.enc (npm run seal:keys)");
if (!(await exists(`${ROOT}/secrets/hedera.enc`))) missing.push("secrets/hedera.enc (npm run seal:keys)");
if (!process.env.MANDATE_HEDERA_ACCOUNT_ID) missing.push("MANDATE_HEDERA_ACCOUNT_ID");
if (!process.env.SERVICE_PAY_TO) missing.push("SERVICE_PAY_TO (must differ from the payer)");
if (!process.env.MANDATE_HCS_TOPIC_ID) missing.push("MANDATE_HCS_TOPIC_ID (npm run provision:hcs)");

const pass = await ensureWalletPass();
if (!pass) missing.push("WALLET_PASS / OS keychain entry for wallet-cli");

if (missing.length) {
  console.error("Not ready for npm run e2e:payment:");
  for (const m of missing) console.error("  -", m);
  process.exit(1);
}

console.log("READY for npm run e2e:payment");
console.log("  Optional: export SERVICE_PAY_TO=$MANDATE_HEDERA_ACCOUNT_ID");
