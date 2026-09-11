#!/usr/bin/env node
/** Explicit testnet paid restart check. Refuses to run while a Ledger is physically attached. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseMandateFile, scopeOf } from '../packages/gateway/src/mandate-config.ts';
import { resumeMandate } from '../packages/gateway/src/mandate.ts';
import { ensureWalletPass } from './load-wallet-pass.mjs';
import { localOperatorClient } from './operator-client.mjs';
const root = new URL('..', import.meta.url).pathname;
const nativeAddonsDisabled = process.execArgv.includes('--no-addons');
const HID = nativeAddonsDisabled ? null : (await import('node-hid')).default;
const devices = HID ? HID.devices().filter(device => device.vendorId === 0x2c97) : null;
if (devices?.length) throw new Error('Unplug the Ledger for the physical USB-less check, or explicitly run Node with --no-addons for a separate HID-disabled broker check. No payment was attempted.');
const api = await localOperatorClient();
const state = await api('/api/state');
if (state.financial?.deposit !== 'funded' || !['10000','20000'].includes(state.financial?.spent)) throw new Error('This live check requires one or two completed 0.01-USDC calls and no prior headless payment');
await api('/api/release', {});
const cfg = parseMandateFile(await readFile(`${root}/state/live/operator/active-mandate.yaml`, 'utf8'));
await ensureWalletPass();
const mandate = await resumeMandate({
  scope: scopeOf(cfg), expectedPayer: cfg.operatorAddress, rpcUrl: cfg.rpcUrl,
  storageRoot: resolve(root, cfg.storageRoot), sessionKeyName: cfg.sessionKey,
  sealedSessionKey: await readFile(`${root}/secrets/${cfg.sessionKey}.enc`),
  ceilingBaseUnits: cfg.ceilingBaseUnits, salt: cfg.salt,
});
try {
  const url = new URL(cfg.serviceUrl);
  url.searchParams.set('q', '{ agents(first: 3, orderBy: totalFeedback, orderDirection: desc) { id agentId agentWallet totalFeedback } _meta { block { number } } }');
  const before = mandate.journal.totals(mandate.id, cfg.windowMs);
  const response = await mandate.fetch(url, { headers: { 'idempotency-key': 'live-headless-20260911-v1' } });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(mandate.taps, 0);
  assert.ok(body.sourceMetadata?.block?.number);
  if (HID) assert.equal(HID.devices().filter(device => device.vendorId === 0x2c97).length, 0, 'Keep Ledger unplugged until the proof completes');
  const after = mandate.journal.totals(mandate.id, cfg.windowMs);
  assert.equal(BigInt(after.spent) - BigInt(before.spent), 10000n);
  const proof = {
    ok: true, checkedAt: new Date().toISOString(), pid: process.pid,
    mode: 'fresh-process-session-only', nativeAddonsDisabled, physicalDisconnectVerified: Boolean(HID), ledgerInterfacesBefore: HID ? 0 : null, ledgerInterfacesAfter: HID ? 0 : null,
    newDeviceSignatures: mandate.taps, channelId: mandate.journal.mandate(mandate.id).channel_id,
    before, after, result: body, paymentResponse: response.headers.get('payment-response'),
  };
  await writeFile(`${root}/.live-results/repair/headless-live.json`, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ ok: true, pid: process.pid, nativeAddonsDisabled, physicalDisconnectVerified: Boolean(HID), newDeviceSignatures: 0, channelId: proof.channelId, before, after, source: body.source, block: body.sourceMetadata.block.number }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { mandate.close(); }
