import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileResearchQuery,
  normalizeResearchTask,
  validateResearchSource,
} from "./research-task.ts";

const source = validateResearchSource({
  provider: "the-graph",
  chain: "base",
  deployment: "BTjind17gmRZ6YhT9peaCM13SvWuqztsmqyfjpntbg3Z",
});
const task = normalizeResearchTask({ version: 1, template: "agent0-due-diligence", source, maxResults: 5 }, source);

test("research intent compiles a bounded read-only query", () => {
  const query = compileResearchQuery(task);
  assert.match(query, /agents\(first: 5/);
  assert.match(query, /_meta \{ block \{ number \} \}/);
  assert.throws(() => normalizeResearchTask({ ...task, maxResults: 11 }, source), /2 to 10/);
  assert.throws(() => validateResearchSource({ ...source, deployment: "guess" }), /exact discovered/);
});
