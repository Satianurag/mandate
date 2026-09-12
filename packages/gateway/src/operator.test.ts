import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOperatorApp } from './operator.ts';
import { OperatorAuth } from './operator-auth.ts';
import { Journal, digest } from './journal.ts';
import { scopeOf, type MandateFile } from './mandate-config.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const RESEARCH_SOURCE = { provider: 'the-graph' as const, chain: 'bsc-chapel' as const, deployment: 'BTjind17gmRZ6YhT9peaCM13SvWuqztsmqyfjpntbg3Z' };
const RESEARCH_TASK = { version: 1 as const, template: 'agent0-due-diligence' as const, source: RESEARCH_SOURCE, maxResults: 5 };
const DISCOVERED_SOURCES = { 'bsc-chapel': RESEARCH_SOURCE.deployment };
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'mandate-operator-'));
  const app = await createOperatorApp({ root, dataDir: directory, port: 0 });
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
  rpcUrl:'https://mainnet.base.org',serviceUrl:'http://127.0.0.1:1/analytics',
  asset:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
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
test('retired operator mutations cannot create a second engine or fund an old authority', async t => {
 const {request, app} = await setup(t);
 for(const path of ['/api/config','/api/tasks','/api/delegate','/api/settle','/api/refund'])assert.equal((await request(path,{})).status,410);
 assert.equal(app.journal.mandates().length,0);
});
test('the canonical HTML has no legacy or login frontend, and old assets are gone', async t => {
 const {origin}=await setup(t);
 const html=await(await fetch(origin+'/')).text();
 assert.doesNotMatch(html,/loginPanel|legacy-|compat-only|style\.css|mandate-sculpture/);
 for(const path of ['/index.html','/style.css','/mandate-sculpture.png','/onboard/done.html'])assert.equal((await fetch(origin+path)).status,404);
 assert.equal(await(await fetch(origin+'/workspace')).text(),html);
});
