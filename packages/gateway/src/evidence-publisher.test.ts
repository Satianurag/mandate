import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@hiero-ledger/sdk";
import { Journal } from "./journal.ts";
import { signAnchor, verifyAnchor, flushOutbox } from "./evidence-publisher.ts";

test("public-topic authorship is verified cryptographically against a configured key", () => {
  const journal = new Journal(":memory:"), key = PrivateKey.generateECDSA();
  journal.event("m", "request", "payment.accepted", { amount: "10000", trace: ["scope:matched"] });
  const event = journal.events()[0]!;
  const anchor = signAnchor(event, "0.0.123", key);
  const expected = { account: "0.0.123", publicKey: key.publicKey.toStringDer() };
  assert.ok(verifyAnchor(anchor, expected, event));
  assert.equal(verifyAnchor({ ...anchor, kind: "refunded" }, expected, event), false);
  assert.equal(verifyAnchor(anchor, expected, { ...event, data: '{"amount":"0"}' }), false);
  assert.equal(verifyAnchor(anchor, { ...expected, publicKey: PrivateKey.generateECDSA().publicKey.toStringDer() }), false);
  assert.ok(Buffer.byteLength(JSON.stringify(anchor)) <= 1024);
  journal.close();
});
test("outbox retains failures and retries idempotent event IDs before confirming consensus", async () => {
  const journal = new Journal(":memory:"), key = PrivateKey.generateECDSA();
  const id = journal.event("m", null, "request.started", { amount: "10000" });
  let attempt = 0;
  const opts = { topic: "0.0.123", account: "0.0.456", key, send: async (_topic: string, anchor: ReturnType<typeof signAnchor>) => {
    assert.equal(anchor.eventId, id);
    if (attempt++ === 0) throw new Error("network down");
    return { transactionId: "fixture-consensus-receipt", topicSequenceNumber: "1", topicRunningHash: "00", status: "SUCCESS" };
  } };
  assert.equal((await flushOutbox(journal, opts)).failed, 1);
  assert.equal(journal.events()[0]!.anchor_state, "failed");
  assert.equal((await flushOutbox(journal, opts)).confirmed, 1);
  assert.equal(journal.events()[0]!.attempts, 2);
  assert.equal((await flushOutbox(journal, opts)).confirmed, 0);
  journal.close();
});

test("one evidence consent plan caps the combined workspace, buyer and merchant batch", async () => {
  const { planEvidenceBatch } = await import("./evidence-publisher.ts");
  const plan = planEvidenceBatch([
    { journal: "workspace", pending: 7 },
    { journal: "buyer", pending: 19 },
    { journal: "merchant", pending: 4 },
  ]);
  assert.equal(plan.pendingRecords, 30);
  assert.equal(plan.maxRecordsPerAction, 20);
  assert.equal(plan.plannedRecords, 20);
  assert.equal(plan.estimatedSubmissions, 20);
  assert.deepEqual(plan.journals, [
    { journal: "workspace", pending: 7, planned: 7 },
    { journal: "buyer", pending: 19, planned: 13 },
    { journal: "merchant", pending: 4, planned: 0 },
  ]);
  assert.equal(plan.perRecordMaxTransactionFeeHbar, "0.25");
  assert.equal(plan.worstCaseConfiguredMaxFeeHbar, "5");
  assert.match(plan.consentHash, /^[a-f0-9]{64}$/);
  assert.equal(planEvidenceBatch([{ journal: "workspace", pending: 3 }]).worstCaseConfiguredMaxFeeHbar, "0.75");
});
