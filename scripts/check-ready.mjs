#!/usr/bin/env node
/**
 * Preflight for live payment scripts — exits 0 when ready, 1 with checklist otherwise.
 */

import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { ensureWalletPass } from "./load-wallet-pass.mjs";
import { findServicePayTo } from "./resolve-pay-to.mjs";

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
if (!process.env.MANDATE_HCS_TOPIC_ID) missing.push("MANDATE_HCS_TOPIC_ID (npm run provision:hcs)");
const payer = process.env.MANDATE_HEDERA_ACCOUNT_ID ?? "";
const payTo = payer ? await findServicePayTo(payer) : process.env.SERVICE_PAY_TO?.trim();
if (!payTo) missing.push("SERVICE_PAY_TO distinct from payer (npm run setup:merchant)");

const pass = await ensureWalletPass();
if (!pass) missing.push("WALLET_PASS / OS keychain entry for wallet-cli");

if (missing.length) {
  console.error("Not ready for npm run e2e:payment:");
  for (const m of missing) console.error("  -", m);
  process.exit(1);
}

console.log("READY for npm run e2e:payment");
console.log(`  payer=${payer}  merchant=${payTo}`);
