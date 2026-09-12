import { test } from "node:test";
import assert from "node:assert/strict";
import { Journal } from "./journal.ts";

test("merchant receipts are idempotent and bind to the reviewed request digest", () => {
  const journal = new Journal(":memory:");
  const response = { status: 200, headers: {}, body: '{"ok":true}' };
  assert.equal(journal.merchantBegin("payment", "request"), null);
  assert.throws(() => journal.merchantBegin("payment", "request"), /reconciliation/);
  journal.merchantState("payment", "settling");
  journal.merchantComplete("payment", response);
  assert.deepEqual(journal.merchantBegin("payment", "request"), response);
  assert.throws(() => journal.merchantBegin("payment", "other"), /different resource/);
  journal.close();
});

test("reservations enforce shared and per-run budgets atomically", (t) => {
  const journal = new Journal(":memory:");
  t.after(() => journal.close());
  const limits = { ceilingBaseUnits: "100", perCallBaseUnits: "50", windowBaseUnits: "100", windowMs: 60000 };
  journal.register("shared", limits);
  const request = {
    mandateId: "shared",
    digest: "intent",
    network: "eip155:8453",
    asset: "USDC",
    amount: "40",
    limits,
    group: { id: "one-run", ceilingBaseUnits: "50", perCallBaseUnits: "50" },
  };
  journal.reserve({ ...request, id: "first" });
  assert.throws(() => journal.reserve({ ...request, id: "second" }), /Run lifetime/);
  assert.throws(() => journal.reserve({ ...request, id: "increase", group: { ...request.group, ceilingBaseUnits: "100" } }), /immutable/);
  journal.reserve({ ...request, id: "another-run", group: { ...request.group, id: "two-run" } });
  assert.throws(() => journal.reserve({ ...request, id: "third-run", group: { ...request.group, id: "three-run" } }), /Lifetime budget/);
  assert.equal(journal.totals("shared", 60000).reserved, "80");
});
