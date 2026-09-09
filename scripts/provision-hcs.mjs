#!/usr/bin/env node
/**
 * Create an HCS audit topic on Hedera testnet using the sealed payment key.
 *
 * Prerequisites: secrets/hedera.enc, MANDATE_HEDERA_ACCOUNT_ID, WALLET_PASS
 */

import { readFile } from "node:fs/promises";
import {
  Client,
  PrivateKey,
  AccountId,
  TopicCreateTransaction,
} from "@hiero-ledger/sdk";
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
need("MANDATE_HEDERA_ACCOUNT_ID");
if (!process.env.WALLET_PASS) {
  console.error("WALLET_PASS missing — run npm run device first");
  process.exit(1);
}

const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
const hederaEnc = await readFile(`${ROOT}/secrets/hedera.enc`);

await withSecret("hedera-payment", hederaEnc, async (key) => {
  const hex = key.toString("utf8").trim().replace(/^0x/, "");
  const client = Client.forTestnet();
  client.setOperator(
    AccountId.fromString(process.env.MANDATE_HEDERA_ACCOUNT_ID),
    PrivateKey.fromStringECDSA(hex)
  );

  const response = await new TopicCreateTransaction()
    .setTopicMemo("Mandate audit trail — ETHOnline 2026")
    .execute(client);
  const receipt = await response.getReceipt(client);
  const topicId = receipt.topicId?.toString();
  client.close();

  if (!topicId) {
    console.error("HCS_PROVISION_FAILED: no topic id in receipt");
    process.exit(1);
  }

  console.log(`HCS_OK topicId=${topicId}`);
  console.log(`export MANDATE_HCS_TOPIC_ID=${topicId}`);
});
