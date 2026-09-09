#!/usr/bin/env node
/**
 * Live end-to-end payment: real 402 → real reputation → real policy →
 * real device step-up when escalated → real facilitator settlement →
 * real HCS record, verified by reading it back from the mirror node.
 *
 * Nothing is bypassed. If policy escalates, tap the Ledger when prompted.
 * If policy allows headlessly, the record still lands on HCS either way.
 *
 * Requires: secrets/hedera.enc (+ secrets/graph.enc for reputation),
 *   MANDATE_HEDERA_ACCOUNT_ID (payer), SERVICE_PAY_TO (receiver, distinct),
 *   MANDATE_HCS_TOPIC_ID, WALLET_PASS.
 */

import { spawn } from "node:child_process";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const SERVICE_PORT = Number(process.env.SERVICE_PORT ?? 8403);
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
const payer = need("MANDATE_HEDERA_ACCOUNT_ID");
const payTo = need("SERVICE_PAY_TO");
const topicId = need("MANDATE_HCS_TOPIC_ID");
if (!process.env.WALLET_PASS) {
  console.error("WALLET_PASS missing — run npm run device first");
  process.exit(1);
}
if (payTo === payer) {
  // Self-transfers net to zero and fail facilitator verify. This is a
  // configuration error, so it fails here with its name — never silently
  // rewritten to some other account.
  console.error(`SERVICE_PAY_TO (${payTo}) must differ from the payer (${payer}).`);
  process.exit(1);
}

const svc = spawn(
  process.execPath,
  ["--experimental-strip-types", `${ROOT}/packages/service/src/index.ts`],
  { env: process.env, stdio: "inherit" }
);
await new Promise((r) => setTimeout(r, 2500));

try {
  const { proxyFetch } = await import(`${ROOT}/packages/gateway/src/index.ts`);
  const { pollTopicRecord } = await import(`${ROOT}/packages/gateway/src/evidence.ts`);

  const url = `http://127.0.0.1:${SERVICE_PORT}/analytics?q=${encodeURIComponent("{ agents { id } }")}`;
  console.log(`e2e payment → ${url}`);
  console.log("(tap the Ledger if policy escalates to step_up)");

  const res = await proxyFetch(url);
  const body = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(body.slice(0, 600));

  if (res.status !== 200) {
    console.error("E2E_FAILED: payment did not settle");
    process.exit(1);
  }
  const parsed = JSON.parse(body);
  const txId = parsed.paid?.txId;
  if (!txId) {
    console.error("E2E_FAILED: no settlement txId in response");
    process.exit(1);
  }
  console.log(`settled: ${txId}`);

  // The audit record is part of the payment. A submit that never becomes
  // readable never happened — poll the mirror until it lands.
  const found = await pollTopicRecord(
    topicId,
    (r) => r?.txId === txId,
    { timeoutMs: 90_000 }
  );
  console.log(
    `HCS verified: seq=${found.sequence} consensus=${found.consensusTimestamp} verdict=${found.record.verdict}`
  );
  console.log(`E2E_OK txId=${txId} hcsSeq=${found.sequence}`);
} finally {
  svc.kill();
}
