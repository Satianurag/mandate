#!/usr/bin/env node
/** Preflight for npm run spike:envelope — exits 0 when env is set. */

const missing = [];
if (!process.env.MANDATE_EVM_SIGNING_KEY) missing.push("MANDATE_EVM_SIGNING_KEY (Base Sepolia payer)");
if (!process.env.MANDATE_EVM_RECEIVER) missing.push("MANDATE_EVM_RECEIVER (payTo address)");

if (missing.length) {
  console.error("Not ready for npm run spike:envelope:");
  for (const m of missing) console.error("  -", m);
  console.error("  Also need Base Sepolia ETH + USDC on the payer.");
  process.exit(1);
}

console.log("READY for npm run spike:envelope");
