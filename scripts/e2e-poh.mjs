#!/usr/bin/env node
/**
 * Phase 4b E2E: Proof of You.
 * Ledger tap (address verify + presence typed data) bound to UAID, then HCS.
 * Replay without a device signature must fail.
 */
import { randomBytes } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
await ensureWalletPass();

const { DmkEvmSigner } = await import(`${ROOT}/packages/gateway/src/dmksigner.ts`);
const { buildPresenceChallenge, assertFreshPresence } = await import(
  `${ROOT}/packages/gateway/src/presence.ts`
);
const { deriveOperatorUaid } = await import(`${ROOT}/packages/gateway/src/uaid.ts`);
const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
const { Client, PrivateKey, AccountId, TopicId, TopicMessageSubmitTransaction } = await import(
  "@hiero-ledger/sdk"
);

const accountId = process.env.MANDATE_HEDERA_ACCOUNT_ID;
const topicId = process.env.MANDATE_HCS_TOPIC_ID;
if (!accountId || !topicId) {
  console.error("Need MANDATE_HEDERA_ACCOUNT_ID and MANDATE_HCS_TOPIC_ID");
  process.exit(1);
}

const uaid = await deriveOperatorUaid(accountId, "hedera:testnet");
const nonce = randomBytes(16).toString("hex");

console.error(">>> Confirm address on Ledger (checkOnDevice)");
const device = await DmkEvmSigner.create({
  timeoutMs: 120_000,
  checkOnDevice: true,
});
const challenge = buildPresenceChallenge({
  operator: device.address,
  uaid,
  nonce,
});

console.error(">>> Sign Proof of You typed data on Ledger");
const signature = await device.signTypedData(challenge);
const attestation = { challenge, signature, address: device.address };
await assertFreshPresence(attestation, { operator: device.address, uaid });

const hederaEnc = await readFile(`${ROOT}/secrets/hedera.enc`);
const record = {
  kind: "poh",
  uaid,
  operator: device.address,
  nonce,
  issuedAt: challenge.message.issuedAt,
  signature,
};
await withSecret("hedera-payment", hederaEnc, async (key) => {
  const hex = key.toString("utf8").trim().replace(/^0x/, "");
  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(accountId), PrivateKey.fromStringECDSA(hex));
  await new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(topicId))
    .setMessage(JSON.stringify(record))
    .execute(client);
  client.close();
});

await mkdir(`${ROOT}/.live-results`, { recursive: true });
await writeFile(
  `${ROOT}/.live-results/e2e-poh.txt`,
  JSON.stringify(
    {
      ok: true,
      uaid,
      operator: device.address,
      signature,
      address: device.address,
      challenge,
      attestation,
    },
    null,
    2
  )
);

console.log("POH_OK", JSON.stringify({ uaid, operator: device.address, taps: device.signCalls }));

try {
  await assertFreshPresence(null, { operator: device.address, uaid });
  console.error("POH_FAILED: replay without attestation should deny");
  process.exit(1);
} catch {
  console.log("POH_REPLAY_DENIED_OK");
}
// Hiero SDK leaves gRPC channels open; force exit after a proven result.
process.exit(0);
