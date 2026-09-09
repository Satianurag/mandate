#!/usr/bin/env node
/**
 * HCS-14 UAID registration: derive the operator's deterministic UAID,
 * inscribe the HCS-11 AI-agent profile carrying it, then read the profile
 * back from the account memo and verify the UAID matches. An inscription
 * that never becomes readable never happened.
 *
 * The profile bytes are the hermetic-tested output of buildOperatorProfile
 * (uaid.test.ts) — this script only transports them with the operator key.
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
if (!process.env.WALLET_PASS) {
  console.error("WALLET_PASS missing — run npm run device first");
  process.exit(1);
}
// HCS11Client speaks mainnet/testnet only; anything else fails here with
// its name instead of inscribing an identity for the wrong network.
const network = process.env.MANDATE_HEDERA_NETWORK ?? "hedera:testnet";
const sdkNetwork =
  network === "hedera:mainnet" ? "mainnet" : network === "hedera:testnet" ? "testnet" : null;
if (!sdkNetwork) {
  console.error(`HCS11Client supports hedera:mainnet/testnet only, got ${network}`);
  process.exit(1);
}

const { deriveOperatorUaid, buildOperatorProfile } = await import(
  `${ROOT}/packages/gateway/src/uaid.ts`
);
const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
const { HCS11Client } = await import("@hashgraphonline/standards-sdk");
const hederaEnc = await readFile(`${ROOT}/secrets/hedera.enc`);

const uaid = await deriveOperatorUaid(accountId, network);
console.log(`operator UAID: ${uaid}`);
const profile = buildOperatorProfile(uaid, accountId);

await withSecret("hedera-payment", hederaEnc, async (key) => {
  const client = new HCS11Client({
    network: sdkNetwork,
    auth: {
      operatorId: accountId,
      privateKey: key.toString("utf8").trim().replace(/^0x/, ""),
    },
    keyType: "ecdsa",
    silent: true,
  });
  const inscribed = await client.inscribeProfile(profile);
  if (!inscribed.success) {
    console.error(`INSCRIBE_FAILED: ${inscribed.error ?? "unknown error"}`);
    process.exit(1);
  }
  console.log(`profile topic: ${inscribed.profileTopicId} tx: ${inscribed.transactionId}`);

  const readBack = await client.fetchProfileByAccountId(accountId, sdkNetwork);
  if (!readBack.success || readBack.profile?.uaid !== uaid) {
    console.error(`READBACK_FAILED: ${readBack.error ?? "profile UAID mismatch"}`);
    process.exit(1);
  }
  console.log(`UAID_OK topic=${inscribed.profileTopicId} tx=${inscribed.transactionId}`);
});
