import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCounterpartyPolicy, skippedCounterpartyPolicy } from "./counterparty-policy.ts";

test("evaluateCounterpartyPolicy denies when no registry deployment answers", () => {
  const decision = evaluateCounterpartyPolicy({
    registered: false,
    feedbackCount: 0,
    meanScore: null,
    revokedCount: 0,
    validationCount: 0,
    chainsQueried: 3,
    chainsReachable: 0,
    chainsFailed: ["base", "ethereum", "polygon"],
  });
  assert.equal(decision.verdict, "deny");
});

test("evaluateCounterpartyPolicy denies on partial registry coverage", () => {
  const decision = evaluateCounterpartyPolicy({
    registered: true,
    feedbackCount: 2,
    meanScore: 0.5,
    revokedCount: 0,
    validationCount: 0,
    chainsQueried: 3,
    chainsReachable: 2,
    chainsFailed: ["polygon"],
  });
  assert.equal(decision.verdict, "deny");
  assert.match(decision.reason, /polygon/);
});

test("evaluateCounterpartyPolicy allows when registry coverage is complete", () => {
  const decision = evaluateCounterpartyPolicy({
    registered: true,
    feedbackCount: 1,
    meanScore: 0.8,
    revokedCount: 0,
    validationCount: 0,
    chainsQueried: 2,
    chainsReachable: 2,
    chainsFailed: [],
  });
  assert.equal(decision.verdict, "allow");
});

test("skippedCounterpartyPolicy allows vendor-only workspaces without Graph credentials", () => {
  assert.equal(skippedCounterpartyPolicy("skipped").verdict, "allow");
});
