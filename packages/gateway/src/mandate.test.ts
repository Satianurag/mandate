import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCeilingStrategy, MandateExhausted } from "./mandate.ts";

const ctx = (over: Record<string, string>) =>
  ({
    paymentRequirements: {},
    channelConfig: {},
    channelId: "0x00",
    clientContext: {},
    requestAmount: "100",
    maxClaimableAmount: "100",
    currentBalance: "0",
    minimumDepositAmount: "100",
    depositAmount: "100",
    ...over,
  }) as never;

test("ceiling strategy funds the full mandate on the empty channel", async () => {
  const strategy = makeCeilingStrategy("5000000");
  assert.equal(await strategy(ctx({})), "5000000");
});

test("ceiling strategy refuses top-ups once a balance exists", async () => {
  const strategy = makeCeilingStrategy("5000000");
  await assert.rejects(async () => strategy(ctx({ currentBalance: "4999900" })), MandateExhausted);
});

test("ceiling strategy refuses a single request above the ceiling", async () => {
  const strategy = makeCeilingStrategy("500");
  await assert.rejects(
    async () => strategy(ctx({ requestAmount: "501" })),
    (e: unknown) => e instanceof MandateExhausted && /exceeds mandate ceiling/.test(e.message)
  );
});

test("ceiling strategy rejects non-positive ceilings at construction", () => {
  assert.throws(() => makeCeilingStrategy("0"), /Invalid mandate ceiling/);
  assert.throws(() => makeCeilingStrategy("-5"), /Invalid mandate ceiling/);
  assert.throws(() => makeCeilingStrategy("1.5"), /Invalid mandate ceiling/);
});
