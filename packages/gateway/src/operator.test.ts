import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOperatorApp, COMPARISON_QUERY, filterMerchantEvidenceEvents, resolvePreflightReview } from './operator.ts';
import { OperatorAuth } from './operator-auth.ts';
import { Journal, digest } from './journal.ts';
import { scopeOf, type MandateFile } from './mandate-config.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const RESEARCH_SOURCE = { provider: 'the-graph' as const, chain: 'bsc-chapel' as const, deployment: 'BTjind17gmRZ6YhT9peaCM13SvWuqztsmqyfjpntbg3Z' };
const RESEARCH_TASK = { version: 1 as const, template: 'agent0-due-diligence' as const, source: RESEARCH_SOURCE, maxResults: 5 };
const DISCOVERED_SOURCES = { 'bsc-chapel': RESEARCH_SOURCE.deployment };
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'mandate-operator-'));
  const app = await createOperatorApp({ root, dataDir: directory, port: 0, discoverResearchSources: async () => DISCOVERED_SOURCES });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const token = await readFile(join(directory,'operator-token'),'utf8');
  const login = await fetch(`${origin}/api/session`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({token})});
  assert.equal(login.status,200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const csrf = (await login.json() as { csrf: string }).csrf;
  const request = (path: string, body?: unknown, overrides: Record<string,string> = {}) => fetch(`${origin}${path}`,{
    method: body === undefined ? 'GET' : 'POST', headers:{cookie,origin,'x-mandate-csrf':csrf,'content-type':'application/json',...overrides},
    ...(body === undefined ? {} : { body:JSON.stringify(body) }),
  });
  return { app, directory, origin, request, cookie, csrf };
}
const cfg = {
  rpcUrl:'https://sepolia.base.org',serviceUrl:'http://127.0.0.1:1/analytics',
  asset:'0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  operatorAddress:'0x0000000000000000000000000000000000000001',receiver:'0x0000000000000000000000000000000000000002',
  receiverAuthorizer:'0x0000000000000000000000000000000000000003',withdrawDelay:86400,
  expiresAt:new Date(Date.now()+3600000).toISOString(),ceilingBaseUnits:'5000000',perCallBaseUnits:'10000',windowBaseUnits:'100000',windowMs:3600000,
  sessionKey:'mandate-session',derivationPath:"44'/60'/0'/0/0",researchSource:RESEARCH_SOURCE,
};
test('operator state requires authentication and rejects cross-origin, bad-CSRF and Host rebinding', async t => {
  const { origin, request } = await setup(t);
  assert.equal((await fetch(`${origin}/api/state`)).status,401);
  assert.equal((await request('/api/state')).status,200);
  assert.equal((await request('/api/config',cfg,{'x-mandate-csrf':'incorrect'})).status,403);
  assert.equal((await request('/api/config',cfg,{origin:'https://attacker.invalid'})).status,403);
  const rebound = await new Promise<number>(resolve => {
    const req = httpRequest(`${origin}/api/state`, { headers: { host: 'attacker.invalid' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode ?? 0));
    }); req.end();
  });
  assert.equal(rebound,403);
  assert.equal((await fetch(`${origin}/onboard/done.html`)).status,404);
});
test('custom agents persist through the authenticated API without silently granting execution authority', async t => {
  const { request, origin } = await setup(t);
  assert.equal((await fetch(`${origin}/api/agents`)).status, 401);
  const before = await (await request('/api/agents')).json() as any;
  assert.equal(before.agents.length, 2); assert.equal(before.ready, false);
  const { id, version, template, requiredToolIds, ...fields } = before.agents[0];
  assert.equal((await request('/api/agents', { ...fields, name: 'My investigator' }, { 'x-mandate-csrf': 'invalid' })).status, 403);
  const savedResponse = await request('/api/agents', { ...fields, name: 'My investigator' });
  assert.equal(savedResponse.status, 201);
  const saved = (await savedResponse.json() as any).agent;
  const after = await (await request('/api/agents')).json() as any;
  assert.equal(after.agents.length, 3); assert.equal(after.agents[2].id, saved.id);
  assert.equal((await request('/api/agent-runs', { requestId: 'agent-test-request', agentId: saved.id, goal: 'Investigate' })).status, 409);
  assert.equal((await request('/api/agent-runs', { requestId: 'agent-test-request', agentId: saved.id, goal: 'Investigate', receiver: 'override' })).status, 400);
});
test('saving authority is a real durable operation but never signs or invents funding', async t => {
  const { request, directory } = await setup(t);
  const response = await request('/api/config',cfg); assert.equal(response.status,201);
  const state = await (await request('/api/state')).json() as any;
  assert.equal(state.financial.deposit,'none'); assert.equal(state.financial.channelId,null);
  assert.equal(state.config.perCallBaseUnits,'10000'); assert.equal(state.tasks.length,0);
  assert.equal(state.evidencePublication.maxRecordsPerAction,20);
  assert.ok(state.evidencePublication.plannedRecords <= 20);
  assert.match(state.evidencePublication.consentHash,/^[a-f0-9]{64}$/);
  assert.match(await readFile(join(directory,'active-mandate.yaml'),'utf8'),/version: 2/);
  assert.equal((await request('/api/capabilities',{task:RESEARCH_TASK})).status,409);
  assert.equal((await request('/api/stop',{})).status,200);
  const stopped = await (await request('/api/state')).json() as any;
  assert.equal(stopped.financial.state,'stopped');
});
test('scoped agents cannot widen query, change authority, read operator state or initiate funding', async t => {
  const { request, app, directory, origin } = await setup(t);
  assert.equal((await request('/api/config',cfg)).status,201);
  const state = await (await request('/api/state')).json() as any;
  const auth = new OperatorAuth(app.journal,directory);
  const capability = auth.createCapability(digest({network:state.config.network,salt:state.config.salt}),RESEARCH_TASK,Date.now()+60000);
  const agent = (path: string, body?: unknown) => fetch(`${origin}${path}`,{
    method:body === undefined ? 'GET':'POST',headers:{authorization:`Bearer ${capability.token}`,'content-type':'application/json'},
    ...(body === undefined ? {} : {body:JSON.stringify(body)}),
  });
  assert.equal((await agent('/api/state')).status,403);
  assert.equal((await agent('/api/config',cfg)).status,403);
  assert.equal((await agent('/api/refund',{confirm:'request_refund'})).status,403);
  assert.equal((await agent('/api/tasks',{task:RESEARCH_TASK,authorizeFunding:true})).status,403);
  assert.equal((await agent('/api/tasks',{task:{...RESEARCH_TASK,maxResults:2}})).status,403);
  assert.equal((await agent('/api/tasks',{task:RESEARCH_TASK,receiver:cfg.receiver})).status,400);
  const queued = await agent('/api/tasks',{task:RESEARCH_TASK}); assert.equal(queued.status,202);
  const task = (await queued.json() as any).task;
  for (let i=0;i<20;i++) {
    const result = await (await agent(`/api/tasks/${task.id}`)).json() as any;
    if (result.task.state==='failed') { assert.match(result.task.error,/operator must authorize initial funding/); break; }
    await new Promise(resolve=>setTimeout(resolve,20));
    if (i===19) assert.fail('Unfunded agent task did not fail closed');
  }
});


test('a fully consumed closed mandate can be replaced without deleting its history or inheriting funding', async t => {
  const { request, app } = await setup(t);
  const bounded = { ...cfg, ceilingBaseUnits: '10000', perCallBaseUnits: '10000', windowBaseUnits: '10000' };
  assert.equal((await request('/api/config', bounded)).status, 201);
  const first = await (await request('/api/state')).json() as any;
  const mandateId = digest({ network: first.config.network, salt: first.config.salt });
  const now = Date.now();
  app.journal.db.prepare("INSERT INTO workspace_tasks(id,kind,mandate_id,query,state,created_at,updated_at) VALUES(?,'query',?,'','failed',?,?)")
    .run('historical-query', mandateId, now, now);
  app.journal.event(mandateId, 'historical-query', 'task.failed', { preserved: true });
  const channelId = `0x${'56'.repeat(32)}`;
  const financial = new Journal(join(resolve(root, first.config.storageRoot), 'broker.sqlite'));
  try {
    const scope = scopeOf(first.config);
    financial.register(mandateId, { scope, salt: first.config.salt });
    financial.bindChannel(mandateId, channelId);
    financial.depositOnce(mandateId);
    financial.funded(mandateId, { channelId });
    financial.reserve({ id: 'full-spend', mandateId, digest: digest({ run: 1 }), network: first.config.network,
      asset: first.config.asset, amount: '10000', limits: scope });
    financial.signed('full-spend', { voucher: 'full' });
    financial.accept('full-spend', '10000', { transaction: 'accepted' });
    financial.closeFullySpent(mandateId, '10000', {
      network: first.config.network, channelId, balanceBaseUnits: '10000', claimedBaseUnits: '10000',
      receiverAggregateClaimedBaseUnits: '10000', receiverAggregateSettledBaseUnits: '10000', withdrawalAmountBaseUnits: '0',
    });
  } finally { financial.close(); }

  const replacement = await request('/api/config', { ...bounded, expiresAt: new Date(Date.now() + 7200000).toISOString() });
  assert.equal(replacement.status, 201);
  const second = await (await request('/api/state')).json() as any;
  assert.notEqual(second.config.salt, first.config.salt);
  assert.notEqual(second.config.storageRoot, first.config.storageRoot);
  assert.equal(second.financial.deposit, 'none');
  assert.equal(second.financial.channelId, null);
  assert.equal(second.tasks.length, 0);
  assert.equal(second.historicalTaskCount, 1);
  assert.equal(second.historicalTasks.length, 1);
  assert.equal(second.historicalTasks[0].id, 'historical-query');
  assert.equal(second.historicalTasks[0].mandate_id, mandateId);
  assert.equal(Object.hasOwn(second.historicalTasks[0], 'result'), false);
  const historicalDetailResponse = await request('/api/tasks/historical-query');
  assert.equal(historicalDetailResponse.status, 200);
  const historicalDetail = await historicalDetailResponse.json() as any;
  assert.equal(historicalDetail.task.id, 'historical-query');
  assert.equal(historicalDetail.task.mandate_id, mandateId);
  const secondMandateId = digest({ network: second.config.network, salt: second.config.salt });
  assert.ok(second.events.every((event: any) => event.mandate_id === secondMandateId));
  assert.ok(second.historicalWorkspaceEventCount >= 2);
  const historical = new Journal(join(resolve(root, first.config.storageRoot), 'broker.sqlite'));
  try {
    assert.equal(historical.mandate(mandateId)?.state, 'closed');
    assert.equal(historical.events(mandateId).filter(event => event.kind === 'mandate.closed').length, 1);
  } finally { historical.close(); }
});


test('task request IDs bind to one canonical source-bound intent', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/api/config', cfg)).status, 201);
  const requestId = 'stable-request-0001';
  const first = await request('/api/tasks', { task: RESEARCH_TASK, requestId });
  assert.equal(first.status, 202);
  const second = await request('/api/tasks', { task: RESEARCH_TASK, requestId });
  assert.equal(second.status, 202);
  assert.equal((await second.json() as any).task.id, requestId);
  const changed = await request('/api/tasks', { task: { ...RESEARCH_TASK, maxResults: 2 }, requestId });
  assert.equal(changed.status, 409);
  assert.match((await changed.json() as any).error, /bound to another task/);
  const state = await (await request('/api/state')).json() as any;
  assert.equal(state.tasks.filter((task: any) => task.id === requestId).length, 1);
  assert.deepEqual(state.tasks.find((task: any) => task.id === requestId).task, RESEARCH_TASK);
});

test('research source must match live discovery before authority is saved', async t => {
  const { request } = await setup(t);
  const sources = await (await request('/api/research/sources')).json() as any;
  assert.deepEqual(sources.sources, [{ chain: 'bsc-chapel', deployment: RESEARCH_SOURCE.deployment }]);
  const bad = await request('/api/config', { ...cfg, researchSource: { ...RESEARCH_SOURCE, deployment: '4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u' } });
  assert.equal(bad.status, 409);
  assert.match((await bad.json() as any).error, /does not match live Agent0 discovery/);
});


test('terminal mandates reject merchant settlement before queuing another lifecycle task', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/api/config', cfg)).status, 201);
  const initial = await (await request('/api/state')).json() as any;
  const mandateId = digest({ network: initial.config.network, salt: initial.config.salt });
  const channelId = `0x${'78'.repeat(32)}`;
  const financial = new Journal(join(resolve(root, initial.config.storageRoot), 'broker.sqlite'));
  try {
    financial.register(mandateId, { scope: scopeOf(initial.config), salt: initial.config.salt });
    financial.bindChannel(mandateId, channelId);
    financial.depositOnce(mandateId);
    financial.funded(mandateId, { channelId });
    financial.refundConfirmed(mandateId, {
      transaction: `0x${'34'.repeat(32)}`,
      returnedBaseUnits: initial.config.ceilingBaseUnits,
      before: { channelId },
      after: { channelId },
    });
  } finally { financial.close(); }

  const response = await request('/api/settle', { confirm: 'claim_and_settle_testnet' });
  assert.equal(response.status, 409);
  assert.match((await response.json() as any).error, /already refunded/);
  const after = await (await request('/api/state')).json() as any;
  assert.equal(after.tasks.some((task: any) => task.kind === 'settlement'), false);
});


test('draft preflight review never inherits an expired current mandate scope', () => {
  const expired: MandateFile = {
    ...cfg,
    version: 2,
    network: 'eip155:84532',
    asset: cfg.asset as `0x${string}`,
    operatorAddress: cfg.operatorAddress as `0x${string}`,
    receiver: cfg.receiver as `0x${string}`,
    receiverAuthorizer: cfg.receiverAuthorizer as `0x${string}`,
    salt: `0x${'90'.repeat(32)}`,
    storageRoot: 'state/expired',
    expiresAt: '2026-09-10T00:00:00.000Z',
  };
  const draftSource = { provider: 'the-graph' as const, chain: 'monad-testnet' as const, deployment: '8iiMH9sj471jbp7AwUuuyBXvPJqCEsobuHBeUEKQSxhU' };
  const review = resolvePreflightReview({
    reviewDraft: true,
    rpcUrl: 'https://sepolia.base.org',
    serviceUrl: 'http://127.0.0.1:8405/analytics',
    operatorAddress: '0x0000000000000000000000000000000000000009',
    sessionKey: 'fresh-session',
    researchSource: draftSource,
  }, expired);
  assert.equal(review.mode, 'draft_review');
  assert.equal(review.scopeConfig, null);
  assert.equal(review.operatorAddress, '0x0000000000000000000000000000000000000009');
  assert.equal(review.sessionKey, 'fresh-session');
  assert.deepEqual(review.researchSource, draftSource);

  const currentReview = resolvePreflightReview({}, expired);
  assert.equal(currentReview.mode, 'current_mandate');
  assert.equal(currentReview.scopeConfig, expired);
  assert.equal(currentReview.researchSource, expired.researchSource);
});

test('draft preflight review accepts only an exact, safe draft context', () => {
  assert.throws(() => resolvePreflightReview({ reviewDraft: true }, null), /explicit RPC and service URLs/);
  assert.throws(() => resolvePreflightReview({ reviewDraft: 'yes' }, null), /must be boolean/);
  assert.throws(() => resolvePreflightReview({ unexpected: true }, null), /Unsupported preflight field/);
  assert.throws(() => resolvePreflightReview({
    reviewDraft: true,
    rpcUrl: 'https://sepolia.base.org',
    serviceUrl: 'http://127.0.0.1:8405/analytics',
    operatorAddress: 'not-an-address',
    sessionKey: '../secret',
    researchSource: RESEARCH_SOURCE,
  }, null), /valid payer address/);
});


test('merchant evidence is attributed only to the current channel and its payment request', () => {
  const current = `0x${'ab'.repeat(32)}`;
  const old = `0x${'cd'.repeat(32)}`;
  const row = (request_id: string | null, kind: string, data: unknown, seq: number) => ({
    seq,
    id: `event-${seq}`,
    mandate_id: 'merchant',
    request_id,
    kind,
    data: JSON.stringify(data),
    previous_hash: '',
    hash: `hash-${seq}`,
    created_at: seq,
    anchor_state: 'pending',
    attempts: 0,
    receipt: null,
    error: null,
  });
  const events = [
    row('current-payment', 'merchant.payment_accepted', { receipt: { extra: { channelState: { channelId: current } } } }, 4),
    row('current-payment', 'merchant.request_received', { path: '/analytics' }, 3),
    row('old-payment', 'merchant.payment_accepted', { receipt: { extra: { channelState: { channelId: old } } } }, 2),
    row(null, 'merchant.revenue_settled', { transaction: `0x${'12'.repeat(32)}` }, 1),
  ] as any;
  assert.deepEqual(filterMerchantEvidenceEvents(events, current).map(event => event.id), ['event-4', 'event-3']);
  assert.deepEqual(filterMerchantEvidenceEvents(events, null), []);
});
