/**
 * Evidence read path — reconstruct the audit timeline from HCS.
 *
 * The gateway writes verdicts to a consensus topic (`audit.submit`); this
 * module reads them back through the mirror node. The write path without a
 * read path is a claim, not evidence. Live proof: `npm run e2e:audit`
 * writes a probe record and reads it back by sequence number.
 *
 * Mirror API: GET /api/v1/topics/{id}/messages?sequencenumber=gte:N&order=asc
 * Docs: https://docs.hedera.com/hedera/tutorials/consensus/query-messages-with-mirror-node
 */

export const HEDERA_MIRROR_TESTNET = "https://testnet.mirrornode.hedera.com/api/v1";

export interface TopicMessage {
  consensus_timestamp: string;
  message: string; // base64
  payer_account_id: string;
  sequence_number: number;
  topic_id: string;
}

interface MirrorPage {
  messages?: TopicMessage[];
  links?: { next?: string | null };
}

export interface FetchOptions {
  mirrorBase?: string;
  sequenceGte?: number;
  limit?: number;
  order?: "asc" | "desc";
  fetchFn?: typeof fetch;
}

/** One page of topic messages, oldest or newest first. */
export async function fetchTopicMessages(
  topicId: string,
  opts: FetchOptions = {}
): Promise<{ messages: TopicMessage[]; next: string | null }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.mirrorBase ?? HEDERA_MIRROR_TESTNET;
  const params = new URLSearchParams();
  if (opts.sequenceGte !== undefined) params.set("sequencenumber", `gte:${opts.sequenceGte}`);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  params.set("order", opts.order ?? "asc");
  const res = await fetchFn(`${base}/topics/${topicId}/messages?${params}`);
  if (!res.ok) throw new Error(`Hedera mirror: HTTP ${res.status} reading topic ${topicId}.`);
  const body = (await res.json().catch(() => null)) as MirrorPage | null;
  if (!body || !Array.isArray(body.messages)) {
    throw new Error(`Hedera mirror: unparseable messages page for topic ${topicId}.`);
  }
  return { messages: body.messages, next: body.links?.next ?? null };
}

/** Decode one mirror message body from base64 to its JSON record. */
export function decodeRecord<T>(msg: TopicMessage): T {
  return JSON.parse(Buffer.from(msg.message, "base64").toString("utf8")) as T;
}

export interface PollOptions extends FetchOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Poll until a record matching `predicate` lands on the topic, or throw on
 * timeout. Used by live gates to prove the write path end to end — a submit
 * that never becomes readable never happened.
 */
export async function pollTopicRecord<T>(
  topicId: string,
  predicate: (record: T) => boolean,
  opts: PollOptions = {}
): Promise<{ record: T; sequence: number; consensusTimestamp: string }> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { messages } = await fetchTopicMessages(topicId, {
      ...opts,
      order: "desc",
      limit: 25,
    });
    for (const m of messages) {
      let record: T;
      try {
        record = decodeRecord<T>(m);
      } catch {
        continue;
      }
      if (predicate(record)) {
        return {
          record,
          sequence: m.sequence_number,
          consensusTimestamp: m.consensus_timestamp,
        };
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for a matching record on ${topicId}.`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
