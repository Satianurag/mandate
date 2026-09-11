import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOperatorApp, COMPARISON_QUERY } from './operator.ts';
import { OperatorAuth } from './operator-auth.ts';
import { digest } from './journal.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));
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
  rpcUrl:'https://sepolia.base.org',serviceUrl:'http://127.0.0.1:1/analytics',
  asset:'0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  operatorAddress:'0x0000000000000000000000000000000000000001',receiver:'0x0000000000000000000000000000000000000002',
  receiverAuthorizer:'0x0000000000000000000000000000000000000003',withdrawDelay:86400,
  expiresAt:new Date(Date.now()+3600000).toISOString(),ceilingBaseUnits:'5000000',perCallBaseUnits:'10000',windowBaseUnits:'100000',windowMs:3600000,
  sessionKey:'mandate-session',derivationPath:"44'/60'/0'/0/0",
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
test('saving authority is a real durable operation but never signs or invents funding', async t => {
  const { request, directory } = await setup(t);
  const response = await request('/api/config',cfg); assert.equal(response.status,201);
  const state = await (await request('/api/state')).json() as any;
  assert.equal(state.financial.deposit,'none'); assert.equal(state.financial.channelId,null);
  assert.equal(state.config.perCallBaseUnits,'10000'); assert.equal(state.tasks.length,0);
  assert.match(await readFile(join(directory,'active-mandate.yaml'),'utf8'),/version: 2/);
  assert.equal((await request('/api/capabilities',{query:COMPARISON_QUERY})).status,409);
  assert.equal((await request('/api/stop',{})).status,200);
  const stopped = await (await request('/api/state')).json() as any;
  assert.equal(stopped.financial.state,'stopped');
});
test('scoped agents cannot widen query, change authority, read operator state or initiate funding', async t => {
  const { request, app, directory, origin } = await setup(t);
  assert.equal((await request('/api/config',cfg)).status,201);
  const state = await (await request('/api/state')).json() as any;
  const auth = new OperatorAuth(app.journal,directory);
  const capability = auth.createCapability(digest({network:state.config.network,salt:state.config.salt}),COMPARISON_QUERY,Date.now()+60000);
  const agent = (path: string, body?: unknown) => fetch(`${origin}${path}`,{
    method:body === undefined ? 'GET':'POST',headers:{authorization:`Bearer ${capability.token}`,'content-type':'application/json'},
    ...(body === undefined ? {} : {body:JSON.stringify(body)}),
  });
  assert.equal((await agent('/api/state')).status,403);
  assert.equal((await agent('/api/config',cfg)).status,403);
  assert.equal((await agent('/api/refund',{confirm:'request_refund'})).status,403);
  assert.equal((await agent('/api/tasks',{query:COMPARISON_QUERY,authorizeFunding:true})).status,403);
  assert.equal((await agent('/api/tasks',{query:'{ agents(first: 1) { id } }'})).status,403);
  assert.equal((await agent('/api/tasks',{query:COMPARISON_QUERY,receiver:cfg.receiver})).status,400);
  const queued = await agent('/api/tasks',{query:COMPARISON_QUERY}); assert.equal(queued.status,202);
  const task = (await queued.json() as any).task;
  for (let i=0;i<20;i++) {
    const result = await (await agent(`/api/tasks/${task.id}`)).json() as any;
    if (result.task.state==='failed') { assert.match(result.task.error,/operator must authorize initial funding/); break; }
    await new Promise(resolve=>setTimeout(resolve,20));
    if (i===19) assert.fail('Unfunded agent task did not fail closed');
  }
});
