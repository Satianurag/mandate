import { test } from "node:test";
import assert from "node:assert/strict";
import { Journal } from "./journal.ts";
import { AgentStore } from "./agent-store.ts";
import { seedTaskAgent } from "./agent-test-profile.ts";

test("agent store discards profiles after finish but keeps run receipts", (t) => {
  const journal = new Journal(":memory:");
  t.after(() => journal.close());
  const store = new AgentStore(journal.db);
  const agent = seedTaskAgent(store, { name: "Ephemeral investigator" });
  assert.equal(store.profiles().length, 1);
  const run = store.createRun({ id: "store-run-001", agentId: agent.id, goal: "Compare live sources", authorityId: "authority-1" });
  store.claim(run.id);
  store.finish(run.id, "completed", "Report with citations");
  assert.equal(store.profiles().length, 0);
  const kept = store.run(run.id);
  assert.equal(kept?.state, "completed");
  assert.equal(kept?.result, "Report with citations");
  assert.equal(kept?.agent.name, "Ephemeral investigator");
});
