import { test } from "node:test";
import assert from "node:assert/strict";
import { analyticsPayload, fetchAgent0Rows, liveAnalyticsBody } from "./analytics.ts";

test("fetchAgent0Rows maps live Agent0 agents and refuses gateway errors", async () => {
  const fn = (async (_url: string, init?: { body?: string }) => {
    const q = JSON.parse(String(init?.body ?? "{}")).query as string;
    assert.match(q, /agents/);
    return {
      status: 200,
      ok: true,
      json: async () => ({
        data: {
          agents: [
            {
              id: "0xabc",
              agentId: "7",
              agentWallet: "0x1111111111111111111111111111111111111111",
              totalFeedback: "12",
              feedback: [
                { value: "90", isRevoked: false },
                { value: "80", isRevoked: false },
              ],
            },
          ],
        },
      }),
    };
  }) as unknown as typeof fetch;

  const rows = await fetchAgent0Rows("QmFakeSubgraphId0000000000000000000000001", "key", {
    fetchFn: fn,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, "0xabc");
  assert.equal(rows[0]!.sampleMean, null);
  assert.deepEqual(rows[0]!.measurements?.map(m => m.value), ["90", "80"]);
  assert.notEqual(rows[0]!.id, "agent-demo-1");

  const boom = (async () => ({
    status: 200,
    ok: true,
    json: async () => ({ errors: [{ message: "auth error: API key not found" }] }),
  })) as unknown as typeof fetch;
  await assert.rejects(
    () => fetchAgent0Rows("id", "key", { fetchFn: boom }),
    /API key not found/
  );
});

test("analyticsPayload never includes a demo placeholder", () => {
  const body = analyticsPayload("{ agents { id } }", { chain: "base-sepolia", subgraphId: "abc" }, [], {
    amount: "10000",
  });
  assert.equal(JSON.stringify(body).includes("agent-demo-1"), false);
  assert.equal((body as { ok: boolean }).ok, true);
});


test("audit regression: the actual paid query reaches the live data boundary", async () => {
  const query = "{ agents(first: 2) { id agentId totalFeedback } }";
  let executed = "";
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    executed = JSON.parse(String(init?.body)).query;
    return new Response(JSON.stringify({ data: { agents: [] } }), { status: 200 });
  }) as typeof fetch;
  const body = await liveAnalyticsBody(query, {}, { apiKey: "unit-test-key", subgraphs: { "base-sepolia": "fixture" }, fetchFn });
  assert.equal(executed, query); assert.deepEqual(body.rows, []);
  await assert.rejects(liveAnalyticsBody("mutation { deleteEverything }", {}, { apiKey: "unit-test-key", subgraphs: {} }), /read-only/);
});


test("explicit source never falls through to a different deployment", async () => {
  const query = "{ agents(first: 2) { id agentId agentWallet totalFeedback feedback(first: 1) { value isRevoked } } _meta { block { number } } }";
  const source = { provider: "the-graph" as const, chain: "bsc-chapel" as const, deployment: "BTjind17gmRZ6YhT9peaCM13SvWuqztsmqyfjpntbg3Z" };
  const seen: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ data: { agents: [], _meta: { block: { number: 77 } } } }), { status: 200 });
  }) as typeof fetch;
  const body = await liveAnalyticsBody(query, {}, { apiKey: "unit-test-key", subgraphs: {
    "base-sepolia": "4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u",
    "bsc-chapel": source.deployment,
  }, fetchFn, source });
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, new RegExp(source.deployment));
  assert.equal((body.source as { chain: string }).chain, "bsc-chapel");
  await assert.rejects(() => liveAnalyticsBody(query, {}, { apiKey: "unit-test-key", subgraphs: { "base-sepolia": "4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u" }, fetchFn, source }), /not available/);
  await assert.rejects(() => liveAnalyticsBody(query, {}, { apiKey: "unit-test-key", subgraphs: { "bsc-chapel": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, fetchFn, source }), /no longer matches/);
  assert.equal(seen.length, 1, "mismatched discovery must fail before querying another deployment");
});
