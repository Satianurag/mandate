import { test } from "node:test";
import assert from "node:assert/strict";
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

test("device approval resolves true when the device signs", async () => {
  let called = 0;
  const ok = await requireDeviceApproval(req, {
    signOnDevice: async () => {
      called++;
    },
  });
  assert.equal(ok, true);
  assert.equal(called, 1);
});

test("device failure maps to StepUpDenied with the device message", async () => {
  await assert.rejects(
    () =>
      requireDeviceApproval(req, {
        signOnDevice: async () => {
          throw new Error("Canceled by user (6982)");
        },
      }),
    (e: unknown) =>
      e instanceof StepUpDenied && /Canceled by user/.test(e.message)
  );
});
