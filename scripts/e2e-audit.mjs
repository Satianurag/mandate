#!/usr/bin/env node
/**
 * HCS audit round trip: submit a probe record, then read it back from the
 * mirror node by its unique nonce. A submit that never becomes readable
 * never happened — this gate proves the evidence path, not just the call.
 */

import { readFile } from "node:fs/promises";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return v;
}

await ensureWalletPass();
const accountId = need("MANDATE_HEDERA_ACCOUNT_ID");
const topicId = need("MANDATE_HCS_TOPIC_ID");
if (!process.env.WALLET_PASS) {
  console.error("WALLET_PASS missing — run npm run device first");
  process.exit(1);
}

const { buildRecord, submit } = await import(`${ROOT}/packages/gateway/src/audit.ts`);
const { pollTopicRecord } = await import(`${ROOT}/packages/gateway/src/evidence.ts`);
const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
const hederaEnc = await readFile(`${ROOT}/secrets/hedera.enc`);

const nonce = `probe-${Date.now()}`;
const record = buildRecord(
  {
    origin: "http://127.0.0.1:8403",
    requirements: {
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.0",
      amount: "2000000",
      payTo: accountId,
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
    trace: ["probe", nonce],
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
  // The nonce rides in txId: the on-topic record carries only the verdict
  // plus a trace hash, so the probe marks itself where it can be found.
  { success: true, transactionId: nonce }
);

await withSecret("hedera-payment", hederaEnc, async (key) => {
  await submit(topicId, record, {
    accountId,
    privateKeyHex: key.toString("utf8").trim(),
  });
});
console.log(`submitted ${nonce}, awaiting consensus…`);

const found = await pollTopicRecord(topicId, (r) => r?.txId === nonce, {
  timeoutMs: 90_000,
});
console.log(`HCS_AUDIT_OK seq=${found.sequence} consensus=${found.consensusTimestamp}`);
