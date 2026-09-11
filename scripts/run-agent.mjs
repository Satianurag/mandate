#!/usr/bin/env node
/** Trusted capability relay + isolated consumer. No Docker socket or host credentials enter the container. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const root = new URL('..', import.meta.url).pathname;
const index = process.argv.indexOf('--capability');
if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: npm run agent -- --capability <operator-created file> [--probe]');
const capability = JSON.parse(await readFile(resolve(process.argv[index + 1]), 'utf8'));
if (capability.broker !== 'http://127.0.0.1:8410' || !/^[A-Za-z0-9_-]{43}$/.test(capability.token ?? '')) throw new Error('Invalid local broker capability');
const image = (await readFile(`${root}/agent/runtime-image.txt`, 'utf8')).trim();
if (!/^node@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('The agent runtime must be pinned to an official Node image digest');
const requestId = process.argv.find(v => v.startsWith('--request-id='))?.slice(13) ?? randomUUID();
const name = `mandate-agent-${randomUUID()}`;
const args = ['run', '--rm', '-i', '--name', name, '--network', 'none', '--read-only', '--user', '1000:1000',
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--memory', '128m', '--cpus', '0.5',
  '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--mount', `type=bind,source=${root}/agent/consumer.mjs,target=/agent/consumer.mjs,readonly`,
  image, 'node', '/agent/consumer.mjs'];
const report = { checkedAt: new Date().toISOString(), image, requestId, probe: process.argv.includes('--probe') };
const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
let result, fatal, totalOutput = 0;
child.stderr.on('data', bytes => { totalOutput += bytes.length; if (totalOutput > 1000000) child.kill(); else process.stderr.write(bytes); });
const lines = createInterface({ input: child.stdout });
let serial = Promise.resolve();
lines.on('line', line => {
  totalOutput += Buffer.byteLength(line);
  serial = serial.then(async () => {
    if (line.length > 32768 || totalOutput > 1000000) throw new Error('Consumer exceeded its bounded IPC output');
    const message = JSON.parse(line);
    if (message.type === 'ready') {
      const inspected = spawnSync('docker', ['inspect', name], { encoding: 'utf8', timeout: 10000 });
      if (inspected.status !== 0) throw new Error('Cannot verify container isolation');
      const metadata = JSON.parse(inspected.stdout)[0];
      assert.equal(metadata.HostConfig.NetworkMode, 'none');
      assert.equal(metadata.HostConfig.ReadonlyRootfs, true);
      assert.equal(metadata.Config.User, '1000:1000');
      assert.equal(metadata.HostConfig.Privileged, false);
      assert.deepEqual(metadata.HostConfig.CapDrop, ['ALL']);
      assert.ok(metadata.HostConfig.SecurityOpt.includes('no-new-privileges'));
      assert.equal(metadata.Mounts.length, 1);
      assert.equal(metadata.Mounts[0].Destination, '/agent/consumer.mjs');
      assert.equal(metadata.Mounts[0].RW, false);
      report.isolation = { ...message.boundary, networkMode: metadata.HostConfig.NetworkMode, readOnlyRootfs: true, nonRoot: true, capabilitiesDropped: ['ALL'], noNewPrivileges: true, hostDataMounts: 0, codeMountReadOnly: true };
      child.stdin.write(`${JSON.stringify({ type: 'init', query: capability.query, requestId, probe: report.probe })}\n`);
      return;
    }
    if (message.type === 'call') {
      let status = 403, body = { error: 'The agent relay only exposes task submission and observation' };
      if (message.path === '/api/tasks' || /^\/api\/tasks\/[A-Za-z0-9_-]{8,128}$/.test(message.path)) {
        const response = await fetch(`${capability.broker}${message.path}`, {
          method: message.body === undefined ? 'GET' : 'POST',
          headers: { authorization: `Bearer ${capability.token}`, ...(message.body === undefined ? {} : { 'content-type': 'application/json' }) },
          body: message.body === undefined ? undefined : JSON.stringify(message.body), redirect: 'error', signal: AbortSignal.timeout(15000),
        });
        status = response.status; body = await response.json();
      }
      child.stdin.write(`${JSON.stringify({ type: 'response', id: message.id, status, body })}\n`);
      return;
    }
    if (message.type === 'result') { result = message.result; return; }
    throw new Error('Unexpected consumer IPC message');
  }).catch(error => { fatal = error; child.kill(); });
});
const timer = setTimeout(() => { fatal = new Error('Consumer exceeded the execution deadline'); child.kill(); }, 240000);
try {
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => resolveExit(code)); });
  await serial;
  if (fatal) throw fatal;
  if (code !== 0 || !result?.ok || !report.isolation) throw new Error(`Isolated consumer failed with exit ${code}`);
  report.result = result; report.ok = true;
  await mkdir(`${root}/.live-results/repair`, { recursive: true });
  await writeFile(`${root}/.live-results/repair/${report.probe ? 'agent-isolation' : 'agent-paid'}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearTimeout(timer);
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10000 });
}
