#!/usr/bin/env node
/**
 * Day 1 — throwaway x402 payment end to end (Hedera exact via Blocky402).
 *
 * Bypasses the policy engine so an unregistered counterparty does not block
 * the de-risk spike. Full proxy + policy path is covered by e2e.test.ts.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

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

if (!process.env.SERVICE_PAY_TO && process.env.MANDATE_HEDERA_ACCOUNT_ID) {
  process.env.SERVICE_PAY_TO = process.env.MANDATE_HEDERA_ACCOUNT_ID;
}
// Payer and payTo must differ — self-transfers net to zero and fail facilitator verify.
if (process.env.SERVICE_PAY_TO === process.env.MANDATE_HEDERA_ACCOUNT_ID) {
  process.env.SERVICE_PAY_TO = "0.0.7162784";
}

await loadWalletPass();
need("MANDATE_HEDERA_ACCOUNT_ID");
if (!process.env.WALLET_PASS) {
  console.error("WALLET_PASS missing — run npm run device first");
  process.exit(1);
}

const { buildAndSign, verify, encodePaymentHeader, buildPaymentPayload } = await import(
  `${ROOT}/packages/gateway/src/hedera.ts`
);
const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
const { BLOCKY402_TESTNET } = await import(`${ROOT}/packages/gateway/src/facilitators.ts`);

const svc = spawn(
  process.execPath,
  ["--experimental-strip-types", `${ROOT}/packages/service/src/index.ts`],
  {
    env: { ...process.env, SERVICE_PORT: String(SERVICE_PORT) },
    stdio: "ignore",
  }
);

await new Promise((r) => setTimeout(r, 1500));

try {
  const url = `http://127.0.0.1:${SERVICE_PORT}/analytics?q=${encodeURIComponent("{ agents { id } }")}`;
  console.log(`e2e payment → ${url}`);

  let res = await fetch(url);
  if (res.status !== 402) {
    console.error(`E2E_FAILED: expected 402, got ${res.status}`);
    process.exit(1);
  }

  const challenge = await res.json();
  const requirements = challenge.accepts?.[0];
  if (!requirements) {
    console.error("E2E_FAILED: 402 carried no payment requirements");
    process.exit(1);
  }

  const hederaEnc = await readFile(`${ROOT}/secrets/hedera.enc`);
  const transaction = await withSecret("hedera-payment", hederaEnc, (key) =>
    buildAndSign(requirements, key)
  );

  const payload = buildPaymentPayload(requirements, transaction, new URL(url).origin);

  const check = await verify(BLOCKY402_TESTNET, requirements, payload);
  if (!check.isValid) {
    console.error(`E2E_FAILED verify: ${check.invalidReason ?? "invalid"}`);
    process.exit(1);
  }

  console.log("verify OK — retrying with x-payment (service settles)");

  res = await fetch(url, { headers: { "x-payment": encodePaymentHeader(payload) } });
  const body = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(body);

  if (res.status !== 200) {
    console.error("E2E_FAILED");
    process.exit(1);
  }

  const parsed = JSON.parse(body);
  if (!parsed.paid?.txId) {
    console.error("E2E_FAILED: no settlement txId in response");
    process.exit(1);
  }

  console.log(`E2E_OK txId=${parsed.paid.txId}`);

  if (process.env.MANDATE_HCS_TOPIC_ID) {
    const { buildRecord, submit } = await import(`${ROOT}/packages/gateway/src/audit.ts`);
    const record = buildRecord(
      {
        origin: new URL(url).origin,
        requirements,
        normalisedAmount: Number(requirements.amount) / 1e8,
        assetSymbol: "HBAR",
      },
      {
        verdict: "allow",
        reason: "Day 1 de-risk payment (policy bypassed)",
        trace: ["e2e:direct"],
        reputation: {
          registered: false,
          feedbackCount: 0,
          meanScore: null,
          revokedCount: 0,
          validationCount: 0,
          chainsQueried: 0,
          chainsReachable: 0,
          chainsFailed: [],
        },
      },
      { success: true, transactionId: parsed.paid.txId }
    );
    await withSecret("hedera-payment", hederaEnc, async (key) => {
      await submit(process.env.MANDATE_HCS_TOPIC_ID, record, {
        accountId: process.env.MANDATE_HEDERA_ACCOUNT_ID,
        privateKeyHex: key.toString("utf8").trim(),
      });
    });
    console.log(`HCS audit submitted to ${process.env.MANDATE_HCS_TOPIC_ID}`);
  }
} finally {
  svc.kill();
}
