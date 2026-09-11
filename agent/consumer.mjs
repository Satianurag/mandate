#!/usr/bin/env node
/** Untrusted deterministic consumer. No credentials, HTTP client, wallet SDK or host files. */
import { createInterface } from 'node:readline';
import { networkInterfaces } from 'node:os';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const lines = createInterface({ input: process.stdin });
const waiters = new Map();
let initResolve;
const initialized = new Promise(resolve => { initResolve = resolve; });
lines.on('line', line => {
  const data = JSON.parse(line);
  if (data.type === 'init') initResolve(data);
  else if (data.type === 'response') { const waiter = waiters.get(data.id); waiters.delete(data.id); waiter?.(data); }
});
const send = data => process.stdout.write(`${JSON.stringify(data)}\n`);
let next = 0;
function call(path, body) {
  const id = String(++next);
  const result = new Promise(resolve => waiters.set(id, resolve));
  send({ type: 'call', id, path, body });
  return result;
}
const interfaces = Object.values(networkInterfaces()).flat().filter(Boolean);
assert.ok(interfaces.every(address => address.internal), 'Consumer must have no external network interface');
assert.notEqual(process.getuid(), 0, 'Consumer must not be root');
assert.equal(process.env.WALLET_PASS, undefined);
let readOnly = false;
try { await writeFile('/agent/readonly-check', 'no secrets'); }
catch (error) { readOnly = ['EROFS', 'EACCES'].includes(error.code); }
assert.equal(readOnly, true, 'Application filesystem must be read-only');
send({ type: 'ready', boundary: { uid: process.getuid(), externalNetworkInterfaces: 0, walletPasswordPresent: false, readOnlyApplication: true } });
const config = await initialized;
const exactTaskBody = config.task ? { task: config.task } : { query: config.query };
if (config.probe) {
  const checks = [];
  const alteredAuthority = config.task
    ? { task: { ...config.task, maxResults: config.task.maxResults === 2 ? 3 : 2 } }
    : { query: '{ agents(first: 1) { id } }' };
  for (const [path, body, expected] of [
    ['/api/state', undefined, 403],
    ['/api/tasks', { ...exactTaskBody, authorizeFunding: true }, 403],
    ['/api/tasks', { ...exactTaskBody, network: 'eip155:1' }, 400],
    ['/api/tasks', alteredAuthority, 403],
  ]) {
    const response = await call(path, body);
    assert.equal(response.status, expected, JSON.stringify(response.body));
    checks.push({ path, expected, actual: response.status });
  }
  send({ type: 'result', result: { ok: true, kind: 'live-isolated-agent-denials', paymentsAttempted: 0, checks } });
  process.exit(0);
}
const response = await call('/api/tasks', { ...exactTaskBody, requestId: config.requestId });
if (response.status !== 202) throw new Error(response.body.error ?? 'Broker rejected the task');
const deadline = Date.now() + 180000;
while (Date.now() < deadline) {
  const response = await call(`/api/tasks/${config.requestId}`);
  if (response.status !== 200) throw new Error(response.body.error ?? 'Cannot observe task');
  const task = response.body.task;
  if (task.state === 'succeeded') {
    const stored = JSON.parse(task.result);
    if (stored.schemaVersion === 1 && stored.brief) {
      send({ type: 'result', result: {
        ok: true, kind: 'source-bound-paid-agent-due-diligence', requestId: config.requestId,
        task: stored.task, recommendation: stored.brief.recommendation,
        candidates: stored.brief.candidates, limitations: stored.brief.limitations,
        provenance: stored.brief.provenance, accounting: stored.brief.accounting,
        payment: stored.brief.payment,
      } });
    } else {
      const body = stored.data;
      send({ type: 'result', result: {
        ok: true, kind: 'legacy-deterministic-paid-agent-comparison', requestId: config.requestId,
        source: body.source, sourceMetadata: body.sourceMetadata, observedAt: body.observedAt,
        comparison: body.rows.map(row => ({ registration: row.id, wallet: row.agentWallet, indexedFeedback: row.totalFeedback })),
        interpretation: 'Feedback counts are not trust scores or permission to spend. Raw measurements and provenance remain in the original result.',
        payment: body.paid,
      } });
    }
    process.exit(0);
  }
  if (['failed', 'blocked', 'uncertain', 'interrupted'].includes(task.state)) throw new Error(`${task.state}: ${task.error}`);
  await new Promise(resolve => setTimeout(resolve, 1000));
}
throw new Error(`Task ${config.requestId} is unresolved. Reuse its identifier to observe it; never create another payment automatically.`);
