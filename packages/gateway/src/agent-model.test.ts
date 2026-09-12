import { test } from "node:test";
import assert from "node:assert/strict";
import { VertexAgentModel, decodeAgentDecision, validateVertexConfig } from "./agent-model.ts";
import { AGENT_TEMPLATES } from "./agent-profiles.ts";
import type { ReasoningContext } from "./agent-runtime.ts";
const config = { project: "test-project", location: "global", model: "gemini-2.5-flash" };
const context: ReasoningContext = { run: { id: "test-run", agent: structuredClone(AGENT_TEMPLATES[0]!), goal: "Investigate", authorityId: "fixed", intentHash: "hash", state: "running", createdAt: 0, updatedAt: 0, deadline: 1000, result: null, error: null }, tools: [], observations: [], failures: [], remainingBaseUnits: "100000", remainingSteps: 12 };
test("Vertex sends bounded JSON reasoning with credentials only in headers and records usage separately", async () => {
  let captured = false;
  const model = new VertexAgentModel(config, { token: async () => "test-credential-not-for-model", fetch: (async (url, options) => {
    assert.equal(String(url), "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google/models/gemini-2.5-flash:generateContent");
    assert.equal(new Headers(options?.headers).get("x-goog-user-project"), "test-project");
    assert.equal(String(options?.body).includes("test-credential-not-for-model"), false);
    const request = JSON.parse(String(options?.body));
    assert.equal(request.generationConfig.responseMimeType, "application/json");
    assert.equal(request.generationConfig.maxOutputTokens, 8192); captured = true;
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ action: "finish", result: "No evidence available.", complete: false, evidenceIds: [] }) }] } }], usageMetadata: { totalTokenCount: 25 } });
  }) as typeof fetch });
  const result = await model.next(context, new AbortController().signal);
  assert.ok(captured); assert.equal(result.decision.action, "finish"); assert.equal(result.usage.billedThroughX402, false); assert.equal(result.usage.totalTokenCount, 25);
});
test("model output cannot invent tools and truncated generations do not execute", async () => {
  assert.throws(() => decodeAgentDecision({ action: "tool", toolId: "shell", toolInputJson: "{}", reason: "Execute" }), /invalid tool/);
  assert.throws(() => validateVertexConfig({ ...config, project: "https://attacker.invalid" }), /project ID/);
  const model = new VertexAgentModel(config, { token: async () => "test", fetch: (async () => Response.json({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"action":"tool"}' }] } }] })) as typeof fetch });
  await assert.rejects(model.next(context, new AbortController().signal), /complete action/);
});

test("MAX_TOKENS retries reasoning once with more room, retains both usage records, and never emits the truncated action", async () => {
  const budgets: number[] = [];
  const model = new VertexAgentModel(config, { token: async () => "test", fetch: (async (_url, options) => {
    budgets.push(JSON.parse(String(options?.body)).generationConfig.maxOutputTokens);
    if (budgets.length === 1) return Response.json({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"action":"tool","toolId":"graph-protocol"' }] } }], usageMetadata: { totalTokenCount: 8192 } });
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ action: "finish", result: "Recovered conclusion without purchasing another source.", complete: false, evidenceIds: [] }) }] } }], usageMetadata: { totalTokenCount: 1500 } });
  }) as typeof fetch });
  const response = await model.next(context,new AbortController().signal);
  assert.deepEqual(budgets,[8192,16384]);assert.equal(response.decision.action,"finish");assert.equal(response.usage.requestCount,2);assert.equal(response.usage.totalTokenCount,9692);
});
