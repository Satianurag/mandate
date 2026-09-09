import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchTopicMessages, decodeRecord, pollTopicRecord } from "./evidence.ts";

const msg = (seq: number, body: unknown) => ({
  consensus_timestamp: `175728000${seq}.000000000`,
  message: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
  payer_account_id: "0.0.5005",
  sequence_number: seq,
  topic_id: "0.0.9001",
});

test("fetch decodes a mirror page and surfaces the next link", async () => {
  const seen: string[] = [];
  const fetchFn = (async (url: string) => {
    seen.push(url);
    return {
      ok: true,
      json: async () => ({
        messages: [msg(7, { verdict: "allow" })],
        links: { next: "/api/v1/topics/0.0.9001/messages?sequencenumber=gt:7" },
      }),
    };
  }) as unknown as typeof fetch;
  const page = await fetchTopicMessages("0.0.9001", { sequenceGte: 7, fetchFn });
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0]!.sequence_number, 7);
  assert.deepEqual(decodeRecord<{ verdict: string }>(page.messages[0]!), { verdict: "allow" });
  assert.ok(page.next?.includes("gt:7"));
  assert.ok(seen[0]!.includes("sequencenumber=gte%3A7"), seen[0]);
});

test("fetch throws loudly on mirror errors, never returns half-pages", async () => {
  const bad = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
  await assert.rejects(() => fetchTopicMessages("0.0.1", { fetchFn: bad }), /HTTP 404/);
  const garbage = (async () => ({
    ok: true,
    json: async () => ({ nope: true }),
  })) as unknown as typeof fetch;
  await assert.rejects(() => fetchTopicMessages("0.0.1", { fetchFn: garbage }), /unparseable/);
});

test("poll finds the matching record across pages and skips undecodable bodies", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    const batch =
      calls === 1
        ? [{ ...msg(1, { verdict: "deny" }), message: "!!!not-base64!!!" }, msg(2, { verdict: "deny" })]
        : [msg(3, { verdict: "allow", nonce: "probe-1" })];
    return { ok: true, json: async () => ({ messages: batch, links: { next: null } }) };
  }) as unknown as typeof fetch;
  const found = await pollTopicRecord<{ verdict: string; nonce?: string }>(
    "0.0.9001",
    (r) => r.nonce === "probe-1",
    { fetchFn, intervalMs: 5, timeoutMs: 2000 }
  );
  assert.equal(found.sequence, 3);
  assert.equal(found.record.verdict, "allow");
});

test("poll times out loudly when nothing matches", async () => {
  const fetchFn = (async () => ({
    ok: true,
    json: async () => ({ messages: [msg(1, { verdict: "deny" })], links: { next: null } }),
  })) as unknown as typeof fetch;
  await assert.rejects(
    () => pollTopicRecord("0.0.9001", () => false, { fetchFn, intervalMs: 5, timeoutMs: 50 }),
    /Timed out/
  );
});
