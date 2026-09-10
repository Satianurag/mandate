#!/usr/bin/env node
/**
 * Treasury top-up operator script (HIP-423 long-term schedule).
 *
 * Checks the gateway payer balance via the mirror node; when it has fallen
 * below the threshold AND no live top-up schedule exists, creates a
 * treasury-signed schedule that executes the top-up `inDays` out.
 *
 * The schedule bytes are the hermetic-tested output of buildTopUpSchedule
 * (treasury.test.ts) — this script only transports them with the treasury
 * key, like uaid-register.mjs does for the HCS-11 profile.
 *
 * Exit verdicts: TOPUP_NOT_NEEDED | TOPUP_PENDING | TOPUP_SCHEDULED
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const RESULT = `${ROOT}/.live-results/treasury-topup.txt`;

async function writeLive(payload) {
  const line = JSON.stringify(payload, null, 2);
  await mkdir(`${ROOT}/.live-results`, { recursive: true });
  await writeFile(RESULT, line + "\n");
  return line;
}

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return v;
}

await ensureWalletPass();
const treasuryId = need("MANDATE_TREASURY_ID");
const payerId = need("MANDATE_HEDERA_ACCOUNT_ID");
if (!process.env.WALLET_PASS) {
  console.error("WALLET_PASS missing — run npm run device first");
  process.exit(1);
}
// Gateway networks are CAIP-style (hedera:testnet); the SDKs want bare names.
const network = process.env.MANDATE_HEDERA_NETWORK ?? "hedera:testnet";
const sdkNetwork =
  network === "hedera:mainnet" ? "mainnet" : network === "hedera:testnet" ? "testnet" : null;
if (!sdkNetwork) {
  console.error(`hedera:mainnet/testnet only, got ${network}`);
  process.exit(1);
}

const hbars = Number(process.env.MANDATE_TOPUP_HBARS ?? "25");
const thresholdHbars = Number(process.env.MANDATE_TOPUP_THRESHOLD_HBARS ?? "10");
const inDays = Number(process.env.MANDATE_TOPUP_IN_DAYS ?? "7");
for (const [name, v, ok] of [
  ["MANDATE_TOPUP_HBARS", hbars, Number.isFinite(hbars) && hbars > 0],
  ["MANDATE_TOPUP_THRESHOLD_HBARS", thresholdHbars, Number.isFinite(thresholdHbars) && thresholdHbars > 0],
  ["MANDATE_TOPUP_IN_DAYS", inDays, Number.isFinite(inDays) && inDays > 0 && inDays <= 60],
]) {
  if (!ok) {
    console.error(`bad ${name}: ${v}`);
    process.exit(1);
  }
}

const {
  buildTopUpSchedule,
  fetchLiveTopUp,
  fetchPayerBalanceTinybars,
  needsTopUp,
  topUpMemo,
} = await import(`${ROOT}/packages/gateway/src/treasury.ts`);
const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
const { Client, PrivateKey } = await import("@hiero-ledger/sdk");

const memo = topUpMemo(payerId, hbars);
const thresholdTinybars = BigInt(Math.trunc(thresholdHbars * 1e8));
const balance = await fetchPayerBalanceTinybars(payerId, { network: sdkNetwork });
console.log(`payer ${payerId} balance: ${balance} tinybars (threshold ${thresholdTinybars})`);
if (!needsTopUp(balance, thresholdTinybars)) {
  console.log("TOPUP_NOT_NEEDED");
  await writeLive({
    ok: true,
    verdict: "TOPUP_NOT_NEEDED",
    treasuryId,
    payerId,
    balance: String(balance),
    thresholdTinybars: String(thresholdTinybars),
    hbars,
    inDays,
  });
  process.exit(0);
}

const live = await fetchLiveTopUp(treasuryId, memo, { network: sdkNetwork });
if (live !== null) {
  console.log(`live schedule ${live.scheduleId} executes ${live.expirationTime}`);
  console.log("TOPUP_PENDING");
  await writeLive({
    ok: true,
    verdict: "TOPUP_PENDING",
    treasuryId,
    payerId,
    scheduleId: live.scheduleId,
    expirationTime: live.expirationTime,
    memo,
  });
  process.exit(0);
}

let treasuryEnc;
try {
  treasuryEnc = await readFile(`${ROOT}/secrets/treasury.enc`);
} catch {
  console.error("secrets/treasury.enc missing — seal the treasury ECDSA key first:");
  console.error("  npm run seal:hedera   # seals payer + treasury keys");
  process.exit(1);
}

const executeAt = new Date(Date.now() + inDays * 86_400_000);
await withSecret("treasury", treasuryEnc, async (secret) => {
  const treasuryKey = PrivateKey.fromStringECDSA(secret.toString("utf8").trim().replace(/^0x/, ""));
  const client =
    sdkNetwork === "mainnet"
      ? Client.forMainnet().setOperator(treasuryId, treasuryKey)
      : Client.forTestnet().setOperator(treasuryId, treasuryKey);
  try {
    const signed = await (
      await buildTopUpSchedule(
        { treasuryId, payerId, hbars, executeAt },
        treasuryKey.publicKey,
      ).freezeWith(client)
    ).sign(treasuryKey);
    const resp = await signed.execute(client);
    const receipt = await resp.getReceipt(client);
    const scheduleId = String(receipt.scheduleId);
    console.log(`schedule ${scheduleId} executes ${executeAt.toISOString()}`);
    console.log("TOPUP_SCHEDULED");
    await writeLive({
      ok: true,
      verdict: "TOPUP_SCHEDULED",
      treasuryId,
      payerId,
      scheduleId,
      executes: executeAt.toISOString(),
      memo,
      hbars,
      waitForExpiry: true,
    });
  } finally {
    await client.close();
  }
});
