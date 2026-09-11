import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, digest } from "./journal.ts";
const limits = { ceilingBaseUnits: "500", perCallBaseUnits: "50", windowBaseUnits: "500", windowMs: 3600000 };
function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "mandate-journal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "journal.sqlite");
}
const request = (id: string) => ({ id, mandateId: "m", digest: digest({ id }), network: "eip155:84532", asset: "USDC", amount: "50", limits });
test("audit regression: 12 simultaneous reservations cannot exceed a budget of 500", (t) => {
  const path = setup(t), a = new Journal(path), b = new Journal(path);
  a.register("m", limits); let accepted = 0;
  for (let i = 0; i < 12; i++) {
    try { (i % 2 ? a : b).reserve(request(String(i))); accepted++; } catch (e) { assert.match(String(e), /budget/); }
  }
  assert.equal(accepted, 10); assert.equal(a.totals("m", limits.windowMs).reserved, "500");
  a.close(); b.close();
  const restarted = new Journal(path);
  assert.throws(() => restarted.reserve(request("restart")), /budget/); restarted.close();
});
test("integer accounting, idempotency and unknown settlements survive restarts", (t) => {
  const path = setup(t); let j = new Journal(path); j.register("m", limits);
  j.reserve(request("one")); j.signed("one", { voucher: "signed" }); j.accept("one", "17", { transaction: "receipt" });
  j.accept("one", "17", { transaction: "receipt" });
  assert.equal(j.totals("m", limits.windowMs).spent, "17");
  assert.throws(() => j.accept("one", "18", {}), /Conflicting/);
  assert.throws(() => j.reserve({ ...request("one"), digest: "changed" }), /Idempotency/);
  j.reserve(request("two")); j.signed("two", { voucher: "pending" }); j.fail("two", "connection lost"); j.close();
  j = new Journal(path);
  assert.equal(j.request("two")?.state, "uncertain");
  assert.equal(j.totals("m", limits.windowMs, Date.now() + 7200000).reserved, "50");
  assert.equal(j.totals("m", limits.windowMs).spent, "17"); j.close();
});
test("scope is immutable, stop persists, lock forbids two live signers", (t) => {
  const path = setup(t), a = new Journal(path), b = new Journal(path);
  a.register("m", limits); assert.throws(() => b.register("m", { ...limits, ceilingBaseUnits: "1000" }), /immutable/);
  const release = a.own("m"); assert.throws(() => b.own("m"), /Another broker/); release(); b.own("m")();
  a.stop("m"); assert.throws(() => b.reserve(request("blocked")), /stopped/); a.close(); b.close();
});
test("one-time approval is action-bound and consumed transactionally", () => {
  const j = new Journal(":memory:"), action = { amount: "50", receiver: "fixed" };
  const nonce = j.challenge(action, Date.now() + 10000);
  assert.throws(() => j.consumeApproval(nonce, { ...action, amount: "500" }, {}), /mismatched/);
  j.consumeApproval(nonce, action, { signatureVerified: true });
  assert.throws(() => j.consumeApproval(nonce, action, {}), /consumed/); j.close();
});
test("merchant retries return the exact saved receipt without executing again", () => {
  const j = new Journal(":memory:"); assert.equal(j.merchantBegin("payment", "request"), null);
  assert.throws(() => j.merchantBegin("payment", "request"), /reconciliation/);
  const response = { status: 200, headers: { "payment-response": "receipt" }, body: '{"rows":[]}' };
  j.merchantComplete("payment", response); assert.deepEqual(j.merchantBegin("payment", "request"), response);
  assert.throws(() => j.merchantBegin("payment", "other"), /different resource/); j.close();
});

test('twelve separate OS processes race for one budget without overspending', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile), path = setup(t);
  const initial = new Journal(path); initial.register('m',limits); initial.close();
  const child = new URL('../test-support/reserve-child.mjs',import.meta.url).pathname;
  const outcomes = await Promise.all(Array.from({length:12},(_,i)=>run(process.execPath,['--experimental-strip-types',child,path,`process-${i}`],{timeout:20000})));
  assert.equal(outcomes.filter(r=>r.stdout==='reserved').length,10);
  assert.equal(outcomes.filter(r=>r.stdout==='rejected').length,2);
  const reopened = new Journal(path); assert.equal(reopened.totals('m',3600000).reserved,'500');
  assert.ok(reopened.verifyEventChain()); reopened.close();
});

test('journal preserves large integer typed-data values exactly', () => {
  const j = new Journal(':memory:');
  j.event('m',null,'signature.context',{value:123456789012345678901234567890n});
  assert.equal(JSON.parse(j.events()[0]!.data).value,'123456789012345678901234567890');
  assert.ok(j.verifyEventChain()); j.close();
});

test('unsigned deposit rejection is recoverable, but any recorded signature forbids a reset', () => {
  const journal = new Journal(':memory:');
  try {
    journal.register('unsigned',{});journal.depositOnce('unsigned');journal.resetUnsignedDeposit('unsigned');
    assert.equal(journal.mandate('unsigned')?.deposit,'none');
    journal.depositOnce('unsigned');journal.event('unsigned',null,'deposit.signature_verified',{signatureHash:'recorded'});
    assert.throws(()=>journal.resetUnsignedDeposit('unsigned'),/signature exists/);
    assert.equal(journal.mandate('unsigned')?.deposit,'pending');
  } finally {journal.close();}
});
test('receipt reconciliation is read-only and never starts a missing merchant payment',()=>{
  const journal = new Journal(':memory:');
  try {
    assert.equal(journal.merchantReceipt('not-received','query'),null);
    assert.equal(journal.db.prepare('SELECT COUNT(*) AS n FROM outcomes').get()?.n,0);
    journal.merchantBegin('paid','query');
    const response={status:200,headers:{'payment-response':'original'},body:'{"ok":true}'};
    journal.merchantComplete('paid',response);
    assert.deepEqual(journal.merchantReceipt('paid','query'),response);
    assert.throws(()=>journal.merchantReceipt('paid','another-query'),/another resource/);
  }finally{journal.close();}
});

test('confirmed refund state and proof are atomic, idempotent and cannot be replaced by another hash',()=>{
 const j=new Journal(':memory:');
 try{
  j.register('m',{});j.bindChannel('m',`0x${'ab'.repeat(32)}`);
  const proof={transaction:`0x${'cd'.repeat(32)}`,returnedBaseUnits:'70000',before:{channelId:`0x${'ab'.repeat(32)}`},after:{channelId:`0x${'ab'.repeat(32)}`}};
  j.refundConfirmed('m',proof);j.refundConfirmed('m',proof);
  assert.equal(j.mandate('m')?.state,'refunded');assert.equal(j.events('m').filter(e=>e.kind==='refund.transaction_confirmed').length,1);
  assert.throws(()=>j.refundConfirmed('m',{...proof,transaction:`0x${'ef'.repeat(32)}`}),/Conflicting/);
  assert.throws(()=>j.assertActive('m'),/refunded/);j.stop('m');assert.equal(j.mandate('m')?.state,'refunded');
 }finally{j.close();}
});
