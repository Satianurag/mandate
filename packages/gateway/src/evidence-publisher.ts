/** Authenticated, retryable HCS anchors. Public topics do not authenticate JSON authors. */
import { Client, PrivateKey, PublicKey, AccountId, TopicId, TopicMessageSubmitTransaction, Hbar } from "@hiero-ledger/sdk";
import { canonical, digest, Journal, type EventRow } from "./journal.ts";

export interface SignedAnchor {
  v: 2; eventId: string; eventHash: string; previousHash: string;
  mandateId: string; requestId: string | null; kind: string; createdAt: number;
  publisherAccount: string; publicKey: string; signature: string;
}
function messageOf(anchor: Omit<SignedAnchor, "signature">): Uint8Array {
  return Buffer.from(canonical(anchor), "utf8");
}
export function signAnchor(event: EventRow, publisherAccount: string, key: PrivateKey): SignedAnchor {
  const body: Omit<SignedAnchor, "signature"> = {
    v: 2, eventId: event.id, eventHash: event.hash, previousHash: event.previous_hash,
    mandateId: event.mandate_id, requestId: event.request_id, kind: event.kind,
    createdAt: event.created_at, publisherAccount, publicKey: key.publicKey.toStringDer(),
  };
  return { ...body, signature: Buffer.from(key.sign(messageOf(body))).toString("hex") };
}
/** Expected publisher key/account are configured independently, not trusted from the message. */
export function verifyAnchor(anchor: SignedAnchor, expected: { account: string; publicKey: string }, event?: EventRow): boolean {
  try {
    if (anchor.v !== 2 || anchor.publisherAccount !== expected.account ||
        anchor.publicKey !== expected.publicKey || !/^[a-f0-9]{128}$/.test(anchor.signature)) return false;
    const { signature, ...body } = anchor;
    if (!PublicKey.fromString(expected.publicKey).verify(messageOf(body), Buffer.from(signature, "hex"))) return false;
    if (event) {
      const actualHash = digest({ id: event.id, mandateId: event.mandate_id, requestId: event.request_id,
        kind: event.kind, data: JSON.parse(event.data), previous: event.previous_hash, at: event.created_at });
      if (actualHash !== event.hash || anchor.eventId !== event.id || anchor.eventHash !== actualHash || anchor.previousHash !== event.previous_hash) return false;
    }
    return true;
  } catch { return false; }
}
export interface AnchorReceipt { transactionId: string | null; topicSequenceNumber: string; topicRunningHash: string; status: string; consensusTimestamp?: string; recoveredFromMirror?: boolean }
export async function publishAnchor(topic: string, anchor: SignedAnchor, key: PrivateKey): Promise<AnchorReceipt> {
  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(anchor.publisherAccount), key);
  client.setMaxAttempts(5);
  client.setRequestTimeout(30000);
  client.setGrpcDeadline(5000);
  try {
    const encoded = canonical(anchor);
    // One bounded signed message; no silent unbounded chunk/fee amplification.
    if (Buffer.byteLength(encoded) > 1024) throw new Error("Authenticated anchor exceeds a single 1024-byte HCS message");
    const tx = await new TopicMessageSubmitTransaction().setTopicId(TopicId.fromString(topic))
      .setRegenerateTransactionId(false).setMaxChunks(1).setMaxTransactionFee(new Hbar(0.25)).setMessage(encoded).execute(client);
    const receipt = await tx.getReceipt(client);
    if (receipt.status.toString() !== "SUCCESS" || !receipt.topicSequenceNumber || !receipt.topicRunningHash) {
      throw new Error(`HCS consensus receipt is incomplete: ${receipt.status}`);
    }
    return { transactionId: tx.transactionId.toString(), topicSequenceNumber: receipt.topicSequenceNumber.toString(),
      topicRunningHash: Buffer.from(receipt.topicRunningHash).toString("hex"), status: receipt.status.toString() };
  } finally { client.close(); }
}
/** A retry first checks consensus readback, so a lost submission response need not pay for a duplicate anchor. */
export async function findAnchorOnMirror(topic: string, anchor: SignedAnchor, expected: {account:string;publicKey:string}): Promise<AnchorReceipt | null> {
  if (!/^0\.0\.[0-9]+$/.test(topic)) throw new Error("Invalid testnet topic ID");
  const base = "https://testnet.mirrornode.hedera.com";
  let path = `/api/v1/topics/${topic}/messages?order=desc&limit=100&timestamp=gte:${Math.max(0,Math.floor(anchor.createdAt/1000)-60)}`;
  for (let page=0;page<10;page++) {
    const response = await fetch(base+path,{signal:AbortSignal.timeout(12000),redirect:"error"});
    if (!response.ok) throw new Error(`Cannot establish prior anchor outcome: mirror HTTP ${response.status}`);
    const body = await response.json() as {messages?:Array<{message:string;sequence_number:number;running_hash:string;consensus_timestamp:string}>;links?:{next?:string|null}};
    if (!Array.isArray(body.messages)) throw new Error("Invalid mirror message page");
    for (const message of body.messages) {
      let candidate: SignedAnchor;
      try {candidate=JSON.parse(Buffer.from(message.message,"base64").toString("utf8"));}catch{continue;}
      if(candidate.eventId!==anchor.eventId || candidate.eventHash!==anchor.eventHash)continue;
      if(!verifyAnchor(candidate,expected))continue;
      return {transactionId:null,topicSequenceNumber:String(message.sequence_number),topicRunningHash:Buffer.from(message.running_hash,"base64").toString("hex"),status:"SUCCESS",consensusTimestamp:message.consensus_timestamp,recoveredFromMirror:true};
    }
    if(!body.links?.next)return null;
    if(!body.links.next.startsWith(`/api/v1/topics/${topic}/messages?`))throw new Error("Unexpected mirror pagination destination");
    path=body.links.next;
  }
  throw new Error("Mirror reconciliation exceeded its bounded search; keep the event pending instead of blindly republishing");
}

/** Explicit operator job. Caller loads keys once from Key Ring; tests inject a transport only. */
export async function flushOutbox(journal: Journal, opts: {
  topic: string; account: string; key: PrivateKey; limit?: number;
  send?: (topic: string, anchor: SignedAnchor, key: PrivateKey) => Promise<AnchorReceipt>;
}): Promise<{ confirmed: number; failed: number; pending: number }> {
  const release = journal.own("hcs-outbox");
  let confirmed = 0, failed = 0;
  try {
    const rows = journal.pendingEvents(opts.limit ?? 25);
    for (const event of rows) {
      try {
        const anchor = signAnchor(event, opts.account, opts.key);
        const prior = event.attempts > 0 && !opts.send
          ? await findAnchorOnMirror(opts.topic,anchor,{account:opts.account,publicKey:opts.key.publicKey.toStringDer()}) : null;
        const receipt = prior ?? await (opts.send ?? publishAnchor)(opts.topic, anchor, opts.key);
        if (receipt.status !== "SUCCESS" || !receipt.topicSequenceNumber || (!receipt.transactionId && !receipt.consensusTimestamp)) throw new Error("Publisher returned no consensus confirmation");
        journal.anchored(event.id, { ...receipt, topic: opts.topic, anchor }); confirmed++;
      } catch (e) {
        journal.anchorFailed(event.id, e instanceof Error ? e.message : String(e)); failed++;
        // Avoid paying for a queue of failures during an outage; preserve everything for retry.
        break;
      }
    }
    return { confirmed, failed, pending: journal.pendingCount() };
  } finally { release(); }
}
