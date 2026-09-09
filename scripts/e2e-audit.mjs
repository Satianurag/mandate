#!/usr/bin/env node
/** Submit a probe audit record to HCS — verifies audit.submit end to end. */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const ROOT = new URL("..", import.meta.url).pathname;

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return v;
}

async function loadWalletPass() {
  if (process.env.WALLET_PASS) return;
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
  await new Promise((r) => c.on("close", r));
  if (out.trim()) process.env.WALLET_PASS = out.trim();
}

await loadWalletPass();
need("MANDATE_HEDERA_ACCOUNT_ID");
need("MANDATE_HCS_TOPIC_ID");
if (!process.env.WALLET_PASS) {
  console.error("WALLET_PASS missing — run npm run device first");
  process.exit(1);
}

const { buildRecord, submit } = await import(`${ROOT}/packages/gateway/src/audit.ts`);
const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
const hederaEnc = await readFile(`${ROOT}/secrets/hedera.enc`);

const record = buildRecord(
  {
    origin: "http://127.0.0.1:8403",
    requirements: {
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.0",
      amount: "2000000",
      payTo: process.env.MANDATE_HEDERA_ACCOUNT_ID,
      maxTimeoutSeconds: 60,
      resource: "probe",
      description: "HCS audit probe",
      extra: { feePayer: "0.0.7162784" },
    },
    normalisedAmount: 0.02,
    assetSymbol: "HBAR",
  },
  {
    verdict: "allow",
    reason: "HCS audit probe",
    trace: ["probe"],
    reputation: {
      registered: true,
      feedbackCount: 10,
      meanScore: 0.9,
      revokedCount: 0,
      validationCount: 0,
      chainsQueried: 1,
      chainsReachable: 1,
      chainsFailed: [],
    },
  },
  { success: true, transactionId: "probe-tx" }
);

await withSecret("hedera-payment", hederaEnc, async (key) => {
  await submit(process.env.MANDATE_HCS_TOPIC_ID, record, {
    accountId: process.env.MANDATE_HEDERA_ACCOUNT_ID,
    privateKeyHex: key.toString("utf8").trim(),
  });
});

console.log("HCS_AUDIT_OK");
