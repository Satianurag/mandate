#!/usr/bin/env node
/** Capture every public page and workspace UI state without triggering payments. */
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const outputDir = join(process.env.HOME ?? '/Users/Apple', 'Documents', 'mandate-screenshots');
const origin = 'http://127.0.0.1:8410';
const tokenPath = process.env.MANDATE_OPERATOR_STATE
  ? join(process.env.MANDATE_OPERATOR_STATE, 'operator-token')
  : join(root, 'state/live/operator/operator-token');
const token = (await readFile(tokenPath, 'utf8')).trim();

const report = { capturedAt: new Date().toISOString(), origin, outputDir, screenshots: [] };

async function shot(page, name, options = {}) {
  const path = join(outputDir, `${name}.png`);
  await page.screenshot({ path, fullPage: options.fullPage ?? true });
  report.screenshots.push({ name, path });
  console.log(`  ✓ ${name}.png`);
}

const launchOptions = existsSync('/Applications/Google Chrome.app')
  ? { channel: 'chrome', headless: true }
  : { headless: true };

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch(launchOptions);
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
  await page.setViewportSize({ width: 1440, height: 1000 });

  const landingSections = [
    { id: 'hero', selector: '.hero' },
    { id: 'idea', selector: '#idea' },
    { id: 'boundaries', selector: '#boundaries' },
    { id: 'workflow', selector: '.workflow' },
    { id: 'closing', selector: '.closing' },
  ];
  for (const section of landingSections) {
    await page.locator(section.selector).scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await shot(page, `03-landing-section-${section.id}`, { fullPage: false });
  }

  // ── Workspace (landing transition) ─────────────────────────────────────────
  console.log('\nWorkspace connected from landing');
  await page.goto(`${origin}/workspace`);
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await shot(page, '04-workspace-from-landing-desktop');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  await shot(page, '05-workspace-from-landing-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });

  // ── Workspace login fallback (direct deep link) ────────────────────────────
  console.log('\nWorkspace login fallback');
  const directContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const directPage = await directContext.newPage();
  await directPage.goto(`${origin}/workspace`);
  await directPage.getByRole('heading', { name: /Let the agent work/ }).waitFor();
  await shot(directPage, '06-workspace-login-fallback-desktop');
  await directPage.locator('#loginPanel details summary').click();
  await directPage.waitForTimeout(150);
  await shot(directPage, '06b-workspace-login-manual-token');
  await directContext.close();

  // ── Workspace (authenticated) ───────────────────────────────────────────────
  console.log('\nWorkspace connected');
  await page.goto(`${origin}/workspace#token=${token}`);
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
  await shot(page, '07-workspace-main-desktop');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await shot(page, '08-workspace-main-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });

  // Task panel close-up
  await page.locator('.task-panel').scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await shot(page, '09-workspace-task-panel', { fullPage: false });

  // Authority panel close-up
  await page.locator('.authority-panel').scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await shot(page, '10-workspace-authority-panel', { fullPage: false });

  // History section (collapsed)
  await page.locator('#history').scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await shot(page, '11-workspace-history', { fullPage: false });

  // History archive expanded
  const archiveSummary = page.locator('.history-archive summary');
  if (await archiveSummary.count() > 0) {
    await page.evaluate(() => { const el = document.querySelector('.history-archive'); if (el) el.open = true; });
    await page.waitForTimeout(300);
    await shot(page, '11b-workspace-history-archive-expanded', { fullPage: false });
    const inspectBtn = page.locator('.history-archive .text-button').first();
    if (await inspectBtn.count() > 0) {
      await inspectBtn.scrollIntoViewIfNeeded();
      await inspectBtn.click();
      await page.waitForTimeout(500);
      await page.locator('.task-panel').screenshot({ path: join(outputDir, '11c-workspace-history-task-inspect.png') });
      report.screenshots.push({ name: '11c-workspace-history-task-inspect', path: join(outputDir, '11c-workspace-history-task-inspect.png') });
      console.log('  ✓ 11c-workspace-history-task-inspect.png');
    }
  }

  // Evidence section
  await page.locator('#evidence').scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await shot(page, '12-workspace-evidence', { fullPage: false });

  // Evidence event detail expanded
  const eventDetail = page.locator('#evidence details summary').first();
  if (await eventDetail.count() > 0) {
    await eventDetail.click();
    await page.waitForTimeout(200);
    await shot(page, '12b-workspace-evidence-event-inspect', { fullPage: false });
  }

  // Expand result details if present
  const resultDetails = page.locator('#result details summary');
  if (await resultDetails.count() > 0) {
    await resultDetails.first().click();
    await page.waitForTimeout(150);
    await page.locator('#result').screenshot({ path: join(outputDir, '13-workspace-result-expanded.png') });
    report.screenshots.push({ name: '13-workspace-result-expanded', path: join(outputDir, '13-workspace-result-expanded.png') });
    console.log('  ✓ 13-workspace-result-expanded.png');
  }

  // Preflight check
  const preflightBtn = page.getByRole('button', { name: 'Check live dependencies', exact: true });
  if (await preflightBtn.isEnabled()) {
    await preflightBtn.click();
    await page.waitForTimeout(800);
    await page.locator('#preflightDetails').evaluate(el => { el.open = true; });
    await page.waitForTimeout(200);
    await shot(page, '14-workspace-preflight', { fullPage: false });
  }

  // Config dialog
  console.log('\nDialogs');
  await page.getByRole('button', { name: 'Review authority', exact: true }).click();
  await page.waitForTimeout(300);
  await page.locator('#configDialog').screenshot({ path: join(outputDir, '15-dialog-review-authority.png') });
  report.screenshots.push({ name: '15-dialog-review-authority', path: join(outputDir, '15-dialog-review-authority.png') });
  console.log('  ✓ 15-dialog-review-authority.png');

  const loadSourcesBtn = page.getByRole('button', { name: 'Verify live research sources', exact: true });
  if (await loadSourcesBtn.isVisible()) {
    await loadSourcesBtn.click();
    await page.waitForTimeout(1500);
    await page.locator('#configDialog').screenshot({ path: join(outputDir, '16-dialog-research-sources.png') });
    report.screenshots.push({ name: '16-dialog-research-sources', path: join(outputDir, '16-dialog-research-sources.png') });
    console.log('  ✓ 16-dialog-research-sources.png');
  }

  const probeBtn = page.getByRole('button', { name: 'Inspect live payment offer', exact: true });
  if (await probeBtn.isVisible()) {
    await probeBtn.click();
    await page.waitForTimeout(2000);
    await page.locator('#configDialog').screenshot({ path: join(outputDir, '16b-dialog-payment-offer.png') });
    report.screenshots.push({ name: '16b-dialog-payment-offer', path: join(outputDir, '16b-dialog-payment-offer.png') });
    console.log('  ✓ 16b-dialog-payment-offer.png');
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Refund dialog (only open if button enabled — no actual refund)
  const refundBtn = page.getByRole('button', { name: 'Request remaining-funds refund', exact: true });
  if (await refundBtn.isEnabled()) {
    await refundBtn.click();
    await page.waitForTimeout(200);
    await page.locator('#refundDialog').screenshot({ path: join(outputDir, '17-dialog-refund.png') });
    report.screenshots.push({ name: '17-dialog-refund', path: join(outputDir, '17-dialog-refund.png') });
    console.log('  ✓ 17-dialog-refund.png');
    await page.keyboard.press('Escape');
  }

  // Funding consent prompt (no payment triggered)
  await page.getByRole('button', { name: 'Run paid task', exact: true }).click();
  await page.waitForTimeout(300);
  await page.locator('.task-panel').screenshot({ path: join(outputDir, '19-workspace-funding-consent-prompt.png') });
  report.screenshots.push({ name: '19-workspace-funding-consent-prompt', path: join(outputDir, '19-workspace-funding-consent-prompt.png') });
  console.log('  ✓ 19-workspace-funding-consent-prompt.png');

  // Full workspace scroll (final overview)
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await shot(page, '20-workspace-full-overview');

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
