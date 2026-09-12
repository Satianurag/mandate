import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AgentStore } from "./agent-store.ts";
import { AgentRuntime, type AgentModel, type AgentToolExecutor } from "./agent-runtime.ts";

function fixture(t: { after: (f: () => void) => void }) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const store = new AgentStore(db);
  store.createRun({ id: "run-test-123", agentId: "protocol-investigator", goal: "Investigate the observed activity spike", authorityId: "test-authority" });
  return store;
}
const executor = (): AgentToolExecutor => ({
  catalog: () => [{ id: "graph-protocol", description: "Activity", inputSchema: {} }, { id: "web-search", description: "Search", inputSchema: {} }],
  quote: async (toolId, input) => ({ toolId, input, network: "eip155:8453", asset: "USDC", amountBaseUnits: "10000", offerId: "test-offer" }),
  execute: async ({ quote, requestId }) => ({ toolId: quote.toolId, requestId, data: quote.toolId === "graph-protocol" ? { spike: true } : { explanation: "launch" }, sources: [], receipt: { network: quote.network, asset: quote.asset, amountBaseUnits: quote.amountBaseUnits, transaction: `test-receipt-${requestId}` } }),
});
test("agent observes a finding, selects a second tool because of it, and completes with both receipts", async t => {
  const store = fixture(t);
  const model: AgentModel = { next: async context => {
    if (!context.observations.length) return { decision: { action: "tool", toolId: "graph-protocol", input: {}, reason: "Establish live activity" }, usage: { calls: 1 } };
    if (context.observations.length === 1) {
      assert.deepEqual(context.observations[0]!.data, { spike: true });
      assert.equal(context.remainingBaseUnits, "90000");
      return { decision: { action: "tool", toolId: "web-search", input: { query: "protocol launch" }, reason: "Investigate the observed spike" }, usage: { calls: 1 } };
    }
    return { decision: { action: "finish", complete: true, result: "Activity rose; a launch is a possible explanation.", evidenceIds: context.observations.map(o => o.requestId) }, usage: { calls: 1 } };
  } };
  const runtime = new AgentRuntime(store, model, executor());
  await Promise.all([runtime.run("run-test-123"), runtime.run("run-test-123")]);
  assert.equal(store.run("run-test-123")!.state, "completed");
  assert.equal(store.events("run-test-123").filter(e => e.kind === "tool_observation").length, 2);
});
test("uncertain payment ends the run and never invokes a replacement paid tool", async t => {
  const store = fixture(t), tools = executor(); let paid = 0, reasoned = 0;
  tools.execute = async () => { paid++; throw new Error("Connection lost after signing"); };
  const runtime = new AgentRuntime(store, { next: async () => { reasoned++; return { decision: { action: "tool", toolId: "web-search", input: {}, reason: "Research" }, usage: {} }; } }, tools);
  await runtime.run("run-test-123");
  assert.equal(paid, 1); assert.equal(reasoned, 1);
  assert.equal(store.run("run-test-123")!.state, "failed");
  assert.ok(store.events("run-test-123").some(e => e.kind === "payment_uncertain"));
});
test("overpriced offers reach the model as feedback without signing", async t => {
  const store = fixture(t), tools = executor(); let signed = false;
  const quote = tools.quote;
  tools.quote = async (...args) => ({ ...await quote(...args), amountBaseUnits: "20001" });
  tools.execute = async () => { signed = true; throw new Error("Should not execute"); };
  const runtime = new AgentRuntime(store, { next: async ctx => ctx.failures.length
    ? { decision: { action: "finish", complete: false, result: "No affordable evidence available.", evidenceIds: [] }, usage: {} }
    : { decision: { action: "tool", toolId: "web-search", input: {}, reason: "Research" }, usage: {} } }, tools);
  await runtime.run("run-test-123"); assert.equal(signed, false); assert.equal(store.run("run-test-123")!.state, "partial");
});
test("stop while reasoning prevents the subsequent payment", async t => {
  const store = fixture(t); let signed = false;
  const tools = executor(); tools.execute = async () => { signed = true; throw new Error("Should not execute"); };
  const runtime = new AgentRuntime(store, { next: async () => {
    runtime.stop("run-test-123");
    return { decision: { action: "tool", toolId: "web-search", input: {}, reason: "Research" }, usage: {} };
  } }, tools);
  await runtime.run("run-test-123"); assert.equal(signed, false); assert.equal(store.run("run-test-123")!.state, "stopped");
});
test("editing a saved agent cannot change an existing run or its idempotent retry", t => {
  const store = fixture(t), { id, version, template, requiredToolIds, ...fields } = store.profile("protocol-investigator");
  const saved = store.save({ ...fields, name: "My analyst" });
  const request = { id: "custom-run-123", agentId: saved.id, goal: "Research", authorityId: "fixed" };
  const first = store.createRun(request);
  store.save({ ...fields, name: "Changed", budgetBaseUnits: "900000" }, saved.id, saved.version);
  assert.deepEqual(store.createRun(request), first);
  assert.equal(store.run(request.id)!.agent.budgetBaseUnits, "100000");
  assert.throws(() => store.createRun({ ...request, goal: "Different" }), /different run intent/);
  assert.throws(() => store.save({ ...fields, name: "Stale" }, saved.id, saved.version), /changed/);
});
test("restart retains checkpoints and marks interrupted work without replaying it", t => {
  const store = fixture(t); store.claim("run-test-123"); store.event("run-test-123", "payment_requested", { id: "pending" });
  const reopened = new AgentStore(store.db); assert.equal(reopened.interruptActive(), 1);
  assert.equal(reopened.run("run-test-123")!.state, "interrupted");
  assert.equal(reopened.claim("run-test-123"), false); assert.equal(reopened.events("run-test-123").length, 1);
});
