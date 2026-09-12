import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, digest } from "./journal.ts";
const limits = { ceilingBaseUnits: "500", perCallBaseUnits: "50", windowBaseUnits: "500", windowMs: 3600000 };
const fullLimits = { ...limits, perCallBaseUnits: "500" };
function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "mandate-journal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "journal.sqlite");
}
const request = (id: string) => ({ id, mandateId: "m", digest: digest({ id }), network: "eip155:8453", asset: "USDC", amount: "50", limits });
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

test('fully consumed mandates close without inventing a zero-value refund', () => {
  const j = new Journal(':memory:');
  const channelId = `0x${'12'.repeat(32)}`;
  const proof = {
    network: 'eip155:8453', channelId, balanceBaseUnits: '500', claimedBaseUnits: '500',
    receiverAggregateClaimedBaseUnits: '500', receiverAggregateSettledBaseUnits: '500',
    withdrawalAmountBaseUnits: '0', blockNumber: '100', observedAt: '2026-09-11T00:00:00.000Z',
  };
  try {
    j.register('m', fullLimits); j.bindChannel('m', channelId); j.depositOnce('m'); j.funded('m', { channelId });
    j.reserve({ ...request('all'), amount: '500', limits: fullLimits }); j.signed('all', { voucher: 'all' }); j.accept('all', '500', { transaction: 'accepted' });
    j.closeFullySpent('m', '500', proof);
    assert.equal(j.mandate('m')?.state, 'closed');
    assert.equal(j.events('m').filter(event => event.kind === 'mandate.closed').length, 1);
    assert.equal(j.events('m').some(event => event.kind === 'refund.transaction_confirmed'), false);
    assert.throws(() => j.assertActive('m'), /closed/);
    j.stop('m');
    assert.equal(j.mandate('m')?.state, 'closed');
    j.closeFullySpent('m', '500', { ...proof, blockNumber: '101', observedAt: '2026-09-11T00:01:00.000Z' });
    assert.equal(j.events('m').filter(event => event.kind === 'mandate.closed').length, 1);
  } finally { j.close(); }
});

test('fully-spent closure fails closed for unresolved, under-spent, unsettled, or withdrawing channels', () => {
  const baseProof = {
    network: 'eip155:8453', channelId: `0x${'34'.repeat(32)}`, balanceBaseUnits: '500', claimedBaseUnits: '500',
    receiverAggregateClaimedBaseUnits: '500', receiverAggregateSettledBaseUnits: '500', withdrawalAmountBaseUnits: '0',
  };
  const make = (id: string) => {
    const j = new Journal(':memory:');
    j.register(id, fullLimits); j.bindChannel(id, baseProof.channelId); j.depositOnce(id); j.funded(id, { channelId: baseProof.channelId });
    return j;
  };
  const unresolved = make('unresolved');
  try {
    unresolved.reserve({ ...request('pending'), mandateId: 'unresolved' });
    assert.throws(() => unresolved.closeFullySpent('unresolved', '500', baseProof), /Resolve uncertain or reserved/);
  } finally { unresolved.close(); }
  const under = make('under');
  try {
    under.reserve({ ...request('part'), mandateId: 'under' }); under.signed('part', {}); under.accept('part', '50', {});
    assert.throws(() => under.closeFullySpent('under', '500', baseProof), /not fully consumed/);
  } finally { under.close(); }
  const unsettled = make('unsettled');
  try {
    unsettled.reserve({ ...request('all-unsettled'), mandateId: 'unsettled', amount: '500', limits: fullLimits }); unsettled.signed('all-unsettled', {}); unsettled.accept('all-unsettled', '500', {});
    assert.throws(() => unsettled.closeFullySpent('unsettled', '500', { ...baseProof, receiverAggregateSettledBaseUnits: '499' }), /unsettled/);
    assert.throws(() => unsettled.closeFullySpent('unsettled', '500', { ...baseProof, withdrawalAmountBaseUnits: '1' }), /withdrawal/);
  } finally { unsettled.close(); }
});

test('timed withdrawal lifecycle is durable, idempotent, and never conflates initiation with returned funds', () => {
  const j = new Journal(':memory:');
  const channelId = `0x${'78'.repeat(32)}`;
  const base = {
    network: 'eip155:8453', channelId, balanceBaseUnits: '500', claimedBaseUnits: '50', payerBalanceBaseUnits: '1000',
    receiverAggregateClaimedBaseUnits: '50', receiverAggregateSettledBaseUnits: '50', withdrawalAmountBaseUnits: '0',
    withdrawalInitiatedAt: 0, blockNumber: '10', observedAt: '2026-09-11T00:00:00.000Z',
  };
  try {
    j.register('timed', limits); j.bindIdentity('timed', '0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002');
    j.bindChannel('timed', channelId); j.depositOnce('timed'); j.funded('timed', { channelId });
    j.reserve({ ...request('timed-charge'), mandateId: 'timed' }); j.signed('timed-charge', {}); j.accept('timed-charge', '50', {});
    const initiation = { transaction: `0x${'ab'.repeat(32)}`, amountBaseUnits: '450', readyAt: 1900,
      before: base, after: { ...base, withdrawalAmountBaseUnits: '450', withdrawalInitiatedAt: 1000, blockNumber: '11' } };
    j.withdrawalInitiated('timed', initiation);
    assert.equal(j.mandate('timed')?.state, 'withdrawal_pending');
    assert.equal(j.events('timed').some(event => event.kind === 'refund.transaction_confirmed'), false);
    j.withdrawalInitiated('timed', initiation);
    assert.equal(j.events('timed').filter(event => event.kind === 'withdrawal.initiated').length, 1);
    j.stop('timed');
    assert.equal(j.mandate('timed')?.state, 'withdrawal_pending');
    const finalization = { transaction: `0x${'cd'.repeat(32)}`, returnedBaseUnits: '450',
      before: initiation.after, after: { ...initiation.after, balanceBaseUnits: '50', payerBalanceBaseUnits: '1450', withdrawalAmountBaseUnits: '0', withdrawalInitiatedAt: 0, blockNumber: '12' } };
    j.withdrawalFinalized('timed', finalization);
    assert.equal(j.mandate('timed')?.state, 'refunded');
    assert.equal(j.events('timed').filter(event => event.kind === 'withdrawal.transaction_confirmed').length, 1);
    j.withdrawalFinalized('timed', finalization);
    assert.equal(j.events('timed').filter(event => event.kind === 'withdrawal.transaction_confirmed').length, 1);
  } finally { j.close(); }
});

test('timed withdrawal journal rejects unsettled liability and unproven token return', () => {
  const j = new Journal(':memory:');
  const channelId = `0x${'90'.repeat(32)}`;
  const base = { network: 'eip155:8453', channelId, balanceBaseUnits: '500', claimedBaseUnits: '50', payerBalanceBaseUnits: '1000',
    receiverAggregateClaimedBaseUnits: '50', receiverAggregateSettledBaseUnits: '49', withdrawalAmountBaseUnits: '0', withdrawalInitiatedAt: 0 };
  try {
    j.register('blocked-timed', limits); j.bindChannel('blocked-timed', channelId); j.depositOnce('blocked-timed'); j.funded('blocked-timed', {});
    j.reserve({ ...request('blocked-charge'), mandateId: 'blocked-timed' }); j.signed('blocked-charge', {}); j.accept('blocked-charge', '50', {});
    const initiation = { transaction: `0x${'ef'.repeat(32)}`, amountBaseUnits: '450', readyAt: 1900,
      before: base, after: { ...base, withdrawalAmountBaseUnits: '450', withdrawalInitiatedAt: 1000 } };
    assert.throws(() => j.withdrawalInitiated('blocked-timed', initiation), /unsettled/);
    initiation.after.receiverAggregateSettledBaseUnits = '50'; initiation.before.receiverAggregateSettledBaseUnits = '50';
    j.withdrawalInitiated('blocked-timed', initiation);
    assert.throws(() => j.withdrawalFinalized('blocked-timed', { transaction: `0x${'12'.repeat(32)}`, returnedBaseUnits: '450', before: initiation.after,
      after: { ...initiation.after, balanceBaseUnits: '50', payerBalanceBaseUnits: '1449', withdrawalAmountBaseUnits: '0', withdrawalInitiatedAt: 0 } }), /expected payer return/);
  } finally { j.close(); }
});
