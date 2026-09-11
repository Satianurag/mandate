#!/usr/bin/env node
// Real browser + real local HTTP application. No network interception, fabricated balances, signing, or payments.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { parse, stringify } from 'yaml';
import { createOperatorApp } from '../packages/gateway/src/operator.ts';
import { Journal, digest } from '../packages/gateway/src/journal.ts';
import { scopeOf } from '../packages/gateway/src/mandate-config.ts';
import { compileResearchQuery } from '../packages/gateway/src/research-task.ts';

const root = new URL('..', import.meta.url).pathname;
const directory = await mkdtemp(join(tmpdir(), 'mandate-browser-'));
const evidence = join(root, '.live-results/repair/browser');
const source = {
  provider: 'the-graph',
  chain: 'bsc-chapel',
  deployment: 'BTjind17gmRZ6YhT9peaCM13SvWuqztsmqyfjpntbg3Z',
};
await mkdir(evidence, { recursive: true });
const app = await createOperatorApp({
  root,
  dataDir: directory,
  port: 0,
  discoverResearchSources: async () => ({ [source.chain]: source.deployment }),
});
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const token = (await readFile(join(directory, 'operator-token'), 'utf8')).trim();
const browser = await chromium.launch(existsSync('/Applications/Google Chrome.app') ? { channel: 'chrome', headless: true } : { headless: true });
const report = { checkedAt: new Date().toISOString(), financialOperations: 0, networkMocks: 0, checks: [], screenshots: [] };

try {
  const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await browserContext.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto(origin);
  await page.getByRole('heading', { name: /Let the agent work/ }).waitFor();
  assert.equal(await page.locator('#workspace').isVisible(), false);

  await page.goto(`${origin}/#token=${token}`);
  await page.getByRole('heading', { name: /One Mandate\. Useful work/ }).waitFor();
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.getByRole('button', { name: 'Run paid task', exact: true }).isEnabled(), false);
  report.checks.push('operator login uses a real server session; URL token is removed; no unfunded success is shown');

  await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'BODY');
  await page.getByRole('button', { name: 'Review authority', exact: true }).click();
  await page.locator('#researchSource option[value="bsc-chapel"]').waitFor({ state: 'attached' });
  await page.locator('#researchSource').selectOption(source.chain);
  await page.locator('#operatorAddress').fill('0x0000000000000000000000000000000000000001');
  await page.locator('#receiver').fill('0x0000000000000000000000000000000000000002');
  await page.locator('#receiverAuthorizer').fill('0x0000000000000000000000000000000000000003');
  await page.locator('#serviceUrl').fill('http://127.0.0.1:1/analytics');
  await page.locator('#ceilingInput').fill('1.234567');
  await page.getByRole('button', { name: 'Save reviewed scope', exact: true }).click();
  await page.getByText('Reviewed source-bound Mandate saved. No funds were authorized or moved.').waitFor();

  assert.equal(await page.locator('#cap').innerText(), '1.234567 USDC');
  assert.equal(await page.locator('#mandateStatus').innerText(), 'Not funded');
  assert.equal(await page.getByRole('button', { name: 'Create scoped agent access' }).isEnabled(), false);
  assert.match(await page.locator('#authorityFields').innerText(), /Payment network[\s\S]*Base Sepolia testnet/);
  assert.match(await page.locator('#authorityFields').innerText(), /Research network[\s\S]*BNB Smart Chain Chapel/);
  assert.match(await page.locator('#authorityFields').innerText(), new RegExp(source.deployment));

  await page.getByRole('button', { name: 'Run paid task', exact: true }).click();
  await page.getByText(/Review and explicitly authorize initial funding/).waitFor();
  const actualState = await page.evaluate(async () => (await fetch('/api/state')).json());
  assert.equal(actualState.config.ceilingBaseUnits, '1234567');
  assert.deepEqual(actualState.config.researchSource, source);
  assert.equal(actualState.tasks.length, 0);
  assert.equal(await page.locator('textarea').count(), 0, 'default product flow must not expose raw GraphQL');
  report.checks.push('source-bound limits persist exactly; default flow has no raw GraphQL editor; checkbox is not simulated Ledger approval');

  // Model a lost browser response after the broker accepted a task. The UI must observe this exact ID, never create another.
  const pendingId = 'browser-pending-0001';
  const task = { ...actualState.defaultTask, maxResults: 3 };
  const now = Date.now();
  app.journal.db.prepare(`INSERT INTO workspace_tasks(
    id,kind,mandate_id,capability_id,query,task_spec,intent_hash,state,result,error,created_at,updated_at
  ) VALUES(?,'query',?,NULL,?,?,?,'uncertain',NULL,'Test fixture: response outcome is uncertain',?,?)`).run(
    pendingId,
    digest({ network: actualState.config.network, salt: actualState.config.salt }),
    compileResearchQuery(task),
    JSON.stringify(task),
    digest(task),
    now,
    now,
  );
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: 'mandate.pending-task.v1',
    value: { version: 1, requestId: pendingId, mandateSalt: actualState.config.salt, payload: { task, requestId: pendingId, authorizeFunding: false }, createdAt: now },
  });
  await page.reload();
  await page.getByText('Previous paid intent needs observation').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Run paid task', exact: true }).isEnabled(), false);
  await page.getByRole('button', { name: 'Check existing task', exact: true }).click();
  await page.getByText(new RegExp(`Task ${pendingId} is uncertain`)).waitFor();
  assert.ok(await page.evaluate(key => localStorage.getItem(key), 'mandate.pending-task.v1'));

  app.journal.db.prepare("UPDATE workspace_tasks SET state='failed',error='Definitive test fixture failure',updated_at=? WHERE id=?").run(Date.now(), pendingId);
  await page.getByRole('button', { name: 'Check existing task', exact: true }).click();
  await page.getByText(new RegExp(`Task ${pendingId} is failed`)).waitFor();
  assert.equal(await page.evaluate(key => localStorage.getItem(key), 'mandate.pending-task.v1'), null);
  assert.equal(await page.getByRole('button', { name: 'Run paid task', exact: true }).isEnabled(), true);
  const storageSnapshot = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])));
  assert.equal(JSON.stringify(storageSnapshot).includes(token), false);
  assert.equal(JSON.stringify(storageSnapshot).includes(actualState.csrf), false);
  report.checks.push('lost-response intent survives reload, blocks duplicate paid runs, observes the same task ID, and stores no operator credential');

  // Model an exactly exhausted funded envelope in the real SQLite backend. The UI must stop before creating a doomed request.
  const mandateId = digest({ network: actualState.config.network, salt: actualState.config.salt });
  const channelId = `0x${'ab'.repeat(32)}`;
  const financialRoot = join(root, actualState.config.storageRoot);
  const financial = new Journal(join(financialRoot, 'broker.sqlite'));
  try {
    financial.register(mandateId, { scope: scopeOf(actualState.config), salt: actualState.config.salt });
    financial.bindChannel(mandateId, channelId);
    financial.depositOnce(mandateId);
    financial.funded(mandateId, { channelId });
    const nowExhausted = Date.now();
    financial.db.prepare(`INSERT INTO requests(
      id,mandate_id,digest,network,asset,maximum,charged,state,created_at,finished_at,receipt
    ) VALUES(?,?,?,?,?,?,?,'accepted',?,?,?)`).run(
      'browser-exhausted-0001',
      mandateId,
      digest({ fixture: 'fully exhausted authority' }),
      actualState.config.network,
      actualState.config.asset,
      actualState.config.ceilingBaseUnits,
      actualState.config.ceilingBaseUnits,
      nowExhausted,
      nowExhausted,
      '{}',
    );
  } finally { financial.close(); }
  await page.reload();
  await page.getByRole('heading', { name: /One Mandate\. Useful work/ }).waitFor();
  assert.equal(await page.locator('#remaining').innerText(), '0 USDC');
  assert.equal(await page.getByRole('button', { name: 'Run paid task', exact: true }).isEnabled(), false);
  assert.match(await page.getByRole('button', { name: 'Run paid task', exact: true }).getAttribute('title'), /No lifetime authority remains/);
  assert.match(await page.locator('#taskHint').innerText(), /Lifetime authority exhausted/);
  assert.equal(await page.getByRole('button', { name: 'Close fully spent Mandate', exact: true }).isEnabled(), true);
  report.checks.push('an exactly exhausted envelope disables Run before submission and points the operator to settlement and closure');
  await rm(financialRoot, { recursive: true, force: true });

  // Prove expiry changes while the page is idle, without relying on state-fingerprint changes or the polling loop.
  const configPath = join(directory, 'active-mandate.yaml');
  const expiring = parse(await readFile(configPath, 'utf8'));
  expiring.expiresAt = new Date(Date.now() + 2200).toISOString();
  await writeFile(configPath, stringify(expiring), { mode: 0o600 });
  await page.reload();
  await page.locator('#mandateStatus').filter({ hasText: 'Not funded' }).waitFor();
  await page.evaluate(() => { clearInterval(refreshTimer); refreshTimer = null; });
  await page.locator('#mandateStatus').filter({ hasText: 'Expired' }).waitFor({ timeout: 5000 });
  assert.equal(await page.getByRole('button', { name: 'Run paid task', exact: true }).isEnabled(), false);
  report.checks.push('idle browser crosses permission expiry locally even when server polling and state fingerprint changes are absent');

  await page.getByRole('button', { name: 'Stop new work', exact: true }).click();
  await page.getByText('New work stopped and agent capabilities revoked. Existing accepted payments were not reversed.').waitFor();
  await page.reload();
  await page.locator('#mandateStatus').filter({ hasText: 'Stopped' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Run paid task', exact: true }).isEnabled(), false);
  report.checks.push('stop is a persisted backend state, survives refresh, revokes future work, and does not claim to reverse accepted payments');

  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${viewport.name} overflow`);
    assert.equal(await page.locator('.brand-tag').isVisible(), true, `${viewport.name} must keep the testnet environment visible`);
    assert.equal((await page.locator('.brand-tag').innerText()).trim(), 'TESTNET');
    const targetMinimum = viewport.name === 'mobile' ? 44 : 40;
    const targets = await page.locator('.text-button:visible, summary:visible').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return { text: element.textContent?.trim(), width: rect.width, height: rect.height, className: element.className };
    }));
    for (const target of targets) {
      assert.ok(target.height >= targetMinimum, `${viewport.name} interactive target ${target.text} is only ${target.height}px high`);
      if (String(target.className).includes('text-button')) assert.ok(target.width >= 44, `${viewport.name} text button ${target.text} is only ${target.width}px wide`);
    }
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    const serious = audit.violations.filter(violation => ['critical', 'serious'].includes(violation.impact));
    report.checks.push({ viewport: viewport.name, axeViolations: audit.violations.map(violation => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.map(node => node.target) })) });
    const path = join(evidence, `${viewport.name}-real-backend-test.png`);
    await page.screenshot({ path, fullPage: true });
    report.screenshots.push(path);
    assert.deepEqual(serious, [], `${viewport.name} accessibility violations: ${serious.map(violation => violation.id).join(',')}`);
  }

  await page.getByRole('button', { name: 'Review authority', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#configDialog').isVisible(), false);
  assert.deepEqual(pageErrors, []);
  report.checks.push('persistent mobile testnet marker, usable inspect/summary targets, responsive layout, keyboard navigation, dialog dismissal, and no JavaScript page errors');
  report.ok = true;
} finally {
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
