import { test } from "node:test";
import assert from "node:assert/strict";
import { Journal } from "./journal.ts";
import { testApproval } from "../test-support/approval.ts";
import { requireDeviceApproval, StepUpDenied } from "./stepup.ts";

const req = {
  proposal: {
    origin: "http://test",
    requirements: {
      scheme: "exact" as const,
      network: "hedera:testnet" as const,
      asset: "0.0.0",
      amount: "1",
      payTo: "0.0.1",
      maxTimeoutSeconds: 60,
      extra: { feePayer: "0.0.2" },
    },
    normalisedAmount: 0.01,
    assetSymbol: "HBAR",
  },
  reason: "test",
  timeoutMs: 1000,
};

test("approval verifies a real signature and persists one-time consumption", async () => {
  const journal = new Journal(":memory:"), deps = testApproval(journal);
  assert.equal(await requireDeviceApproval(req, deps), true);
  assert.equal(journal.db.prepare("SELECT state FROM approvals").get()?.state, "consumed");
  journal.close();
});
test("device denial, wrong signer and zero signatures fail closed", async () => {
  const journal = new Journal(":memory:"), deps = testApproval(journal), other = testApproval(journal);
  await assert.rejects(requireDeviceApproval(req, { ...deps, signOnDevice: async () => { throw new Error("Canceled by user (6982)"); } }), /Canceled by user/);
  await assert.rejects(requireDeviceApproval(req, { ...deps, signOnDevice: other.signOnDevice }), /does not match/);
  await assert.rejects(requireDeviceApproval(req, { ...deps, signOnDevice: async () => `0x${"00".repeat(65)}` }), StepUpDenied);
  journal.close();
});
