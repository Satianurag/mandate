#!/usr/bin/env node
/** Capture every public page and agent-workspace UI state without triggering payments. */
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const port = Number(process.env.MANDATE_CONSOLE_PORT ?? 8420);
const outputDir = join(process.env.HOME ?? '/Users/Apple', 'Documents', 'mandate-screenshots');
const origin = `http://127.0.0.1:${port}`;
const tokenDir = process.env.MANDATE_OPERATOR_STATE ?? join(root, 'state/agents/operator');
const token = (await readFile(join(tokenDir, 'operator-token'), 'utf8')).trim();

const report = { capturedAt: new Date().toISOString(), origin, port, outputDir, screenshots: [] };

async function shot(page, name, options = {}) {
  const path = join(outputDir, `${name}.png`);
  if (options.element) {
    await page.locator(options.element).screenshot({ path });
  } else {
    await page.screenshot({ path, fullPage: options.fullPage ?? true });
  }
  report.screenshots.push({ name, path });
  console.log(`  ✓ ${name}.png`);
}

async function navigateView(page, view, headingId) {
  await page.locator(`nav [data-navigate="${view}"]`).first().click();
  await page.locator(`#${headingId}`).waitFor();
  await page.waitForTimeout(200);
}

const launchOptions = existsSync('/Applications/Google Chrome.app')
  ? { channel: 'chrome', headless: true }
  : { headless: true };

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch(launchOptions);
const context = await browser.newContext({ viewport: { width: 1440, height: 1040 } });
const page = await context.newPage();

try {
  // ── Landing page ──────────────────────────────────────────────────────────
  console.log('\nLanding page');
  await page.goto(`${origin}/`);
  await page.locator('img[alt="A silver loop surrounding a luminous yellow core"]').waitFor();
  await shot(page, '01-landing-desktop');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  await shot(page, '02-landing-mobile');
  await page.setViewportSize({ width: 1440, height: 1040 });

  for (const section of [
    { id: 'hero', selector: '.hero' },
    { id: 'idea', selector: '#idea' },
    { id: 'boundaries', selector: '#boundaries' },
    { id: 'workflow', selector: '.workflow' },
    { id: 'closing', selector: '.closing' },
  ]) {
    await page.locator(section.selector).scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await shot(page, `03-landing-section-${section.id}`, { fullPage: false });
  }

  // ── Workspace login (fresh context, no session cookie) ────────────────────
  console.log('\nWorkspace login');
  const loginContext = await browser.newContext({ viewport: { width: 1440, height: 1040 } });
  const loginPage = await loginContext.newPage();
  await loginPage.goto(`${origin}/workspace`);
  await loginPage.locator('#loginPanel').waitFor({ state: 'visible' });
  await shot(loginPage, '04-workspace-login-desktop');

  await loginPage.setViewportSize({ width: 390, height: 844 });
  await loginPage.waitForTimeout(150);
  await shot(loginPage, '05-workspace-login-mobile');
  await loginPage.setViewportSize({ width: 1440, height: 1040 });

  await loginPage.locator('#loginPanel details summary').click();
  await loginPage.waitForTimeout(150);
  await shot(loginPage, '06-workspace-login-manual-token');
  await loginContext.close();

  // ── Agent workspace (authenticated) ─────────────────────────────────────────
  console.log('\nAgent workspace');
  await page.goto(`${origin}/workspace#token=${token}`);
  await page.waitForFunction(() => document.body.classList.contains('agent-mode'));
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.waitForTimeout(500);

  const views = [
    { view: 'home', heading: 'agentHomeTitle', label: 'home' },
    { view: 'task', heading: 'agentsTitle', label: 'task' },
    { view: 'authority', heading: 'agentAllowanceTitle', label: 'authority' },
    { view: 'history', heading: 'agentHistoryTitle', label: 'history' },
    { view: 'evidence', heading: 'agentReceiptsTitle', label: 'evidence' },
  ];

  for (const { view, heading, label } of views) {
    await navigateView(page, view, heading);
    await shot(page, `07-workspace-${label}-desktop`);
  }

  for (const { view, heading, label } of views) {
    await page.setViewportSize({ width: 390, height: 844 });
    await navigateView(page, view, heading);
    await page.waitForTimeout(150);
    await shot(page, `08-workspace-${label}-mobile`);
  }
  await page.setViewportSize({ width: 1440, height: 1040 });

  // Single-query payment diagnostics (legacy batch panel)
  await navigateView(page, 'task', 'agentsTitle');
  await page.evaluate(() => { const el = document.querySelector('.task-diagnostics'); if (el) el.open = true; });
  await page.waitForTimeout(200);
  await shot(page, '09b-workspace-task-diagnostics', { fullPage: false });

  // Allowance technical details
  await navigateView(page, 'authority', 'agentAllowanceTitle');
  await page.evaluate(() => { const el = document.querySelector('#agentAllowancePanel details'); if (el) el.open = true; });
  await page.waitForTimeout(200);
  await shot(page, '09-workspace-allowance-technical', { fullPage: false });

  // Existing run detail
  const runs = await page.evaluate(() => api('/api/agents').then(d => d.runs));
  if (runs?.length) {
    const runId = runs[0].id;
    await page.evaluate(id => sessionStorage.setItem('mandate.agent-run.selected.v1', id), runId);
    await page.reload();
    await page.waitForFunction(() => document.body.classList.contains('agent-mode'));
    await navigateView(page, 'task', 'agentsTitle');
    const detail = page.locator('#agentRunDetail');
    if (await detail.isVisible()) {
      await shot(page, '10-workspace-run-detail-desktop', { element: '#agentRunDetail' });
      const receiptSummary = page.locator('#agentRunDetail details[data-group="receipts"] summary');
      if (await receiptSummary.count() > 0) {
        await receiptSummary.click();
        await page.waitForTimeout(200);
        await shot(page, '10b-workspace-run-receipts-expanded', { element: '#agentRunDetail' });
      }
      const stepsSummary = page.locator('#agentRunDetail details[data-group="steps"] summary');
      if (await stepsSummary.count() > 0) {
        await stepsSummary.click();
        await page.waitForTimeout(200);
        await shot(page, '10c-workspace-run-steps-expanded', { element: '#agentRunDetail' });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(200);
      await shot(page, '10d-workspace-run-detail-mobile', { element: '#agentRunDetail' });
      await page.setViewportSize({ width: 1440, height: 1040 });
    }
  }

  // ── Dialogs (read-only opens, no submissions) ───────────────────────────────
  console.log('\nDialogs');
  await navigateView(page, 'task', 'agentsTitle');

  const createAgentBtn = page.getByRole('button', { name: /Create an agent|Describe the job/i }).first();
  if (await createAgentBtn.count() > 0) {
    await createAgentBtn.click();
    await page.locator('#agentEditor').waitFor();
    await page.waitForTimeout(200);
    await shot(page, '11-dialog-create-agent', { element: '#agentEditor' });
    await page.keyboard.press('Escape');
  }

  const launchBtn = page.locator('.agent-card button').filter({ hasText: /Give it a goal/i }).first();
  if (await launchBtn.count() > 0) {
    await launchBtn.click();
    await page.locator('#agentLaunch').waitFor();
    await page.waitForTimeout(200);
    await shot(page, '12-dialog-launch-agent', { element: '#agentLaunch' });
    await page.keyboard.press('Escape');
  }

  await navigateView(page, 'authority', 'agentAllowanceTitle');
  const reviewFunding = page.locator('#agentReviewFunding');
  if (await reviewFunding.isVisible()) {
    await reviewFunding.click();
    await page.locator('#agentFundingDialog').waitFor();
    await page.waitForTimeout(200);
    await shot(page, '13-dialog-funding-review', { element: '#agentFundingDialog' });
    await page.keyboard.press('Escape');
  }

  const increaseBtn = page.locator('#agentIncreaseAllowance');
  if (await increaseBtn.isVisible()) {
    await increaseBtn.click();
    await page.locator('#agentIncreaseDialog').waitFor();
    await page.waitForTimeout(200);
    await shot(page, '14-dialog-increase-allowance', { element: '#agentIncreaseDialog' });
    const previewBtn = page.locator('#agentPreviewIncrease');
    if (await previewBtn.isVisible()) {
      await previewBtn.click();
      await page.waitForTimeout(1000);
      await shot(page, '14b-dialog-increase-preview', { element: '#agentIncreaseDialog' });
    }
    await page.keyboard.press('Escape');
  }

  const returnBtn = page.locator('#agentReviewReturn');
  if (await returnBtn.isVisible()) {
    await returnBtn.click();
    await page.locator('#agentReturnDialog').waitFor();
    await page.waitForTimeout(200);
    await shot(page, '15-dialog-return-funds', { element: '#agentReturnDialog' });
    await page.keyboard.press('Escape');
  }

  // Final full overview from home
  await navigateView(page, 'home', 'agentHomeTitle');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await shot(page, '16-workspace-full-overview');

  report.ok = true;
  report.count = report.screenshots.length;
} catch (error) {
  report.ok = false;
  report.error = error.message;
  throw error;
} finally {
  await writeFile(join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}

console.log(`\nDone — ${report.screenshots.length} screenshots saved to ${outputDir}`);
