import { test } from "node:test";
import assert from "node:assert/strict";

test("step_up stub approve", async () => {
  process.env.MANDATE_STEPUP_STUB = "approve";
  const { requireDeviceApproval } = await import("./stepup.ts");
  const ok = await requireDeviceApproval({
    proposal: {
      origin: "http://test",
      requirements: {
        scheme: "exact",
        network: "hedera:testnet",
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
  });
  assert.equal(ok, true);
  delete process.env.MANDATE_STEPUP_STUB;
});

test("step_up stub deny", async () => {
  process.env.MANDATE_STEPUP_STUB = "deny";
  const { requireDeviceApproval, StepUpDenied } = await import("./stepup.ts");
  await assert.rejects(
    () =>
      requireDeviceApproval({
        proposal: {
          origin: "http://test",
          requirements: {
            scheme: "exact",
            network: "hedera:testnet",
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
      }),
    StepUpDenied
  );
  delete process.env.MANDATE_STEPUP_STUB;
});
