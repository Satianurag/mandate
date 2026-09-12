import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessResearchSource,
  buildDueDiligenceBrief,
  compileResearchQuery,
  normalizeResearchTask,
  validateResearchSource,
  type ResearchAccounting,
} from "./research-task.ts";

const source = validateResearchSource({
  provider: "the-graph",
  chain: "bsc-chapel",
  deployment: "BTjind17gmRZ6YhT9peaCM13SvWuqztsmqyfjpntbg3Z",
});
const task = normalizeResearchTask({ version: 1, template: "agent0-due-diligence", source, maxResults: 5 }, source);
const accounting: ResearchAccounting = {
  requestId: "request-123", paidCalls: 1, acceptedCostBaseUnits: "10000", reservedBaseUnits: "0",
  remainingAuthorityBaseUnits: "90000", ceilingBaseUnits: "100000", completedAt: "2026-09-11T10:00:00.000Z",
};

test("research intent is exact, source-bound, and compiles a bounded read-only query", () => {
  const query = compileResearchQuery(task);
  assert.match(query, /agents\(first: 5/);
  assert.match(query, /_meta \{ block \{ number \} \}/);
  assert.throws(() => normalizeResearchTask({ ...task, source: { ...source, chain: "base-sepolia" } }, source), /outside the reviewed mandate/);
  assert.throws(() => normalizeResearchTask({ ...task, maxResults: 11 }, source), /2 to 10/);
  assert.throws(() => normalizeResearchTask({ ...task, arbitraryQuery: "mutation" }, source), /unsupported field/);
  assert.throws(() => validateResearchSource({ ...source, deployment: "guess" }), /exact discovered/);
});

test("brief recommends only the best-supported record and keeps evidence limitations explicit", () => {
  const brief = buildDueDiligenceBrief(task, {
    observedAt: "2026-09-11T09:59:00.000Z",
    sourceMetadata: { block: { number: 12345 } },
    paid: { amountBaseUnits: "10000", network: "eip155:8453" },
    rows: [
      { id: "two", agentId: "2", agentWallet: "0x0000000000000000000000000000000000000002", totalFeedback: "7", measurements: [{ value: "A", isRevoked: false }] },
      { id: "one", agentId: "1", agentWallet: "0x0000000000000000000000000000000000000001", totalFeedback: "12", measurements: [{ value: "90", isRevoked: false }, { value: "10", isRevoked: true }] },
    ],
  }, accounting);
  assert.equal(brief.recommendation.status, "best_supported_record");
  assert.equal(brief.recommendation.registration, "1");
  assert.equal(brief.provenance.chain, "bsc-chapel");
  assert.equal(brief.provenance.blockNumber, "12345");
  assert.equal(brief.candidates[0]!.revokedSampledFeedback, 1);
  assert.match(brief.recommendation.basis, /evidence coverage, not a quality guarantee/);
  assert.ok(brief.limitations.some(value => /not calculate a universal trust/.test(value)));
  assert.equal(JSON.stringify(brief).includes("_rankFeedback"), false);
});

test("brief with sparse or empty data withholds a recommendation instead of fabricating one", () => {
  const sparse = buildDueDiligenceBrief(task, { rows: [{ id: "only", totalFeedback: "not-a-number" }] }, accounting);
  assert.equal(sparse.recommendation.status, "insufficient_evidence");
  assert.ok(sparse.candidates[0]!.limitations.length >= 2);
  const empty = buildDueDiligenceBrief(task, { rows: [] }, accounting);
  assert.equal(empty.recommendation.status, "insufficient_evidence");
  assert.match(empty.limitations[0]!, /no matching/);
});


test("research source readiness never treats another chain or changed deployment as fallback", () => {
  const available = assessResearchSource(source, { "bsc-chapel": source.deployment, "base-sepolia": "4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u" });
  assert.deepEqual(available, { ok: true, status: "available", source, discoveredDeployment: source.deployment, fallbackAllowed: false });
  const unavailable = assessResearchSource(source, { "base-sepolia": "4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u" });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.discoveredDeployment, null);
  const changed = assessResearchSource(source, { "bsc-chapel": "4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u" });
  assert.equal(changed.ok, false);
  assert.equal(changed.status, "deployment_changed");
  assert.equal(changed.fallbackAllowed, false);
});
