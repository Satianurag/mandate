/** Optional HCS audit trail. Live topic submits move HBAR and stay gated until explicitly enabled. */
import { Client, AccountId, PrivateKey, TopicId, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { withSecret } from "./keyring.ts";
import { digest } from "./journal.ts";

export function hcsLiveEnabled(): boolean {
  return process.env.MANDATE_HCS_LIVE === "1";
}

export async function maybeAnchorHcs(event: { kind: string; mandateId: string; data: unknown }): Promise<{ submitted: boolean; reason: string; transactionId?: string }> {
  const topicId = process.env.MANDATE_HCS_TOPIC_ID?.trim();
  const accountId = process.env.MANDATE_HEDERA_ACCOUNT_ID?.trim();
  const keyFile = process.env.MANDATE_HEDERA_KEY_ENC?.trim();
  if (!hcsLiveEnabled()) return { submitted: false, reason: "HCS live submit is disabled until an explicit mainnet/demo run" };
  if (!topicId || !accountId || !keyFile) return { submitted: false, reason: "HCS topic, account or sealed key is not configured" };
  const { readFile } = await import("node:fs/promises");
  const ciphertext = await readFile(keyFile);
  const message = JSON.stringify({ kind: event.kind, mandateId: event.mandateId, digest: digest(event.data), at: new Date().toISOString() });
  return withSecret("hedera-payment", ciphertext, async keyBytes => {
    const hex = keyBytes.toString("utf8").trim().replace(/^0x/, "");
    const client = Client.forMainnet();
    try {
      client.setOperator(AccountId.fromString(accountId), PrivateKey.fromStringECDSA(hex));
      client.setMirrorNetwork("mainnet.mirrornode.hedera.com:443");
      const submitted = await new TopicMessageSubmitTransaction()
        .setTopicId(TopicId.fromString(topicId))
        .setMessage(message)
        .execute(client);
      const receipt = await submitted.getReceipt(client);
      return { submitted: true, reason: "anchored", transactionId: submitted.transactionId.toString() + (receipt.status ? `:${receipt.status.toString()}` : "") };
    } finally {
      client.close();
    }
  });
}

/** Fire-and-forget. Live submit stays gated; this is the submitted-path hook. */
export function scheduleHcsAnchor(event: { kind: string; mandateId: string; data: unknown }): void {
  void maybeAnchorHcs(event).catch(() => {});
}
