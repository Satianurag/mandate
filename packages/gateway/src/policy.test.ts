import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyEngine, DEFAULT_POLICY } from "./policy.ts";
import type { CounterpartyReputation, PaymentProposal } from "./types.ts";

const proposal = (amount: number): PaymentProposal => ({
  origin: "https://data.example.com",
  requirements: {
    scheme: "exact",
    network: "hedera:testnet",
    asset: "0.0.0",
    amount: Number.isFinite(amount) ? String(BigInt(Math.round(amount * 1e8))) : "0",
    payTo: "0.0.5005",
    maxTimeoutSeconds: 60,
    extra: { feePayer: "0.0.9001" },
  },
  normalisedAmount: amount,
  assetSymbol: "HBAR",
});

const rep = (o: Partial<CounterpartyReputation> = {}): CounterpartyReputation => ({
  registered: true,
  feedbackCount: 12,
  meanScore: 0.86,
  revokedCount: 0,
  validationCount: 3,
  agentId: "agent-42",
  chain: "base",
  chainsQueried: 9,
  chainsReachable: 9,
  chainsFailed: [],
  ...o,
});

test("well-rated counterparty, small amount -> allow", () => {
  const e = new PolicyEngine();
  assert.equal(e.evaluate(proposal(0.05), rep()).verdict, "allow");
});

test("amount over per-call ceiling -> step_up", () => {
  const e = new PolicyEngine();
  const d = e.evaluate(proposal(DEFAULT_POLICY.perCallCeiling + 0.01), rep());
  assert.equal(d.verdict, "step_up");
  assert.match(d.reason, /per-call ceiling/);
});

test("unregistered counterparty -> step_up even when cheap", () => {
  const e = new PolicyEngine();
  const d = e.evaluate(proposal(0.001), rep({ registered: false, meanScore: null, feedbackCount: 0 }));
  assert.equal(d.verdict, "step_up");
  assert.match(d.reason, /no ERC-8004 identity/);
});

test("score below refusal floor -> deny", () => {
  const e = new PolicyEngine();
  const d = e.evaluate(proposal(0.001), rep({ meanScore: 0.2 }));
  assert.equal(d.verdict, "deny");
});

test("mostly-revoked feedback -> deny", () => {
  const e = new PolicyEngine();
  const d = e.evaluate(proposal(0.001), rep({ feedbackCount: 2, revokedCount: 9 }));
  assert.equal(d.verdict, "deny");
  assert.match(d.reason, /revoked/);
});

test("exhausted rolling budget -> deny", () => {
  const e = new PolicyEngine();
  e.recordSettled(DEFAULT_POLICY.windowBudget - 0.01);
  assert.equal(e.evaluate(proposal(0.4), rep()).verdict, "deny");
});

test("near budget exhaustion -> step_up, not allow", () => {
  const e = new PolicyEngine();
  e.recordSettled(DEFAULT_POLICY.windowBudget * 0.89);
  // 4.45 + 0.10 = 4.55, past the 4.5 (90%) mark but inside the 5.0 budget.
  assert.equal(e.evaluate(proposal(0.1), rep()).verdict, "step_up");
});

test("thin feedback history -> step_up", () => {
  const e = new PolicyEngine();
  assert.equal(e.evaluate(proposal(0.01), rep({ feedbackCount: 1 })).verdict, "step_up");
});

test("partial registry coverage -> step_up, not allow", () => {
  const e = new PolicyEngine();
  const d = e.evaluate(proposal(0.05), rep({ chainsReachable: 6, chainsFailed: ["monad", "monad-testnet", "ethereum-sepolia"] }));
  assert.equal(d.verdict, "step_up");
  assert.match(d.reason, /Could not read 3 of 9/);
});

test("partial coverage is tolerated below the trivial threshold", () => {
  const e = new PolicyEngine();
  const d = e.evaluate(proposal(0.01), rep({ chainsReachable: 6, chainsFailed: ["monad"] }));
  assert.equal(d.verdict, "allow");
});

test("unparseable amount -> deny", () => {
  const e = new PolicyEngine();
  assert.equal(e.evaluate(proposal(Number.NaN), rep()).verdict, "deny");
});

test("spend outside the window is forgotten", () => {
  const e = new PolicyEngine();
  const longAgo = Date.now() - DEFAULT_POLICY.windowMs - 1000;
  e.recordSettled(DEFAULT_POLICY.windowBudget, longAgo);
  assert.equal(e.evaluate(proposal(0.05), rep()).verdict, "allow");
});
