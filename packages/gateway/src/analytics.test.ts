import { test } from "node:test";
import assert from "node:assert/strict";
import { analyticsPayload, fetchAgent0Rows } from "./analytics.ts";

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
  assert.equal(rows[0]!.sampleMean, 85);
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
