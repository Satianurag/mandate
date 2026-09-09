import { test } from "node:test";
import assert from "node:assert/strict";
import { executePayment, policyEngine } from "./index.ts";
import { BLOCKY402_TESTNET } from "./facilitators.ts";
import type { CounterpartyReputation } from "./types.ts";

const reputation: CounterpartyReputation = {
  registered: true,
  feedbackCount: 50,
  meanScore: 0.9,
  revokedCount: 0,
  validationCount: 2,
  chainsQueried: 9,
  chainsReachable: 9,
  chainsFailed: [],
};

const decided = (verdict: "allow" | "deny") => ({
  proposal: {
    origin: "http://127.0.0.1:8403",
    requirements: {
      scheme: "exact" as const,
      network: "hedera:testnet" as const,
      asset: "0.0.0",
      amount: "100000",
      payTo: "0.0.5005",
      maxTimeoutSeconds: 60,
      extra: { feePayer: "0.0.7162784" },
    },
    normalisedAmount: 0.001,
    assetSymbol: "HBAR",
  },
  decision: { verdict, reason: "test", trace: ["test"], reputation },
  reputation,
});

const okDeps = {
  sign: async () => "stub-tx-blob",
  verify: async () => ({ isValid: true as const }),
  settle: async () => ({ success: true as const, transactionId: "0.0.5005@1.0" }),
};

test("F21: settled spend accrues exactly once per successful settlement", async () => {
  const before = policyEngine.spentInWindow();
  const res = await executePayment(decided("allow"), Buffer.from("enc"), BLOCKY402_TESTNET, okDeps);
  assert.equal(res.ok, true);
  assert.ok(Math.abs(policyEngine.spentInWindow() - before - 0.001) < 1e-12);
});

test("F21: failed settlement accrues nothing", async () => {
  const before = policyEngine.spentInWindow();
  const res = await executePayment(decided("allow"), Buffer.from("enc"), BLOCKY402_TESTNET, {
    ...okDeps,
    settle: async () => ({ success: false as const, errorReason: "facilitator exploded" }),
  });
  assert.equal(res.ok, false);
  assert.equal(policyEngine.spentInWindow(), before);
});

test("F21: deny short-circuits without touching sign/verify/settle", async () => {
  let touched = 0;
  const counting = {
    sign: async () => { touched++; return "x"; },
    verify: async () => { touched++; return { isValid: true as const }; },
    settle: async () => { touched++; return { success: true as const }; },
  };
  const before = policyEngine.spentInWindow();
  const res = await executePayment(decided("deny"), Buffer.from("enc"), BLOCKY402_TESTNET, counting);
  assert.equal(res.ok, false);
  assert.equal(touched, 0);
  assert.equal(policyEngine.spentInWindow(), before);
});
