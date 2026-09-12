#!/usr/bin/env node
/** Inspect one existing report. No funding, run creation, signing or payment requests. */
import assert from 'node:assert/strict';import {readFile,mkdir,writeFile} from 'node:fs/promises';import {existsSync} from 'node:fs';
import {chromium} from '@playwright/test';import AxeBuilder from '@axe-core/playwright';
const id=process.argv[2];if(!id||!/^[A-Za-z0-9_-]{8,128}$/.test(id))throw new Error('Supply an existing run ID to inspect');
const origin='http://127.0.0.1:8420',folder='.live-results/agent-integration/browser-live-report';await mkdir(folder,{recursive:true});
const browser=await chromium.launch(existsSync('/Applications/Google Chrome.app')?{channel:'chrome',headless:true}:{headless:true});
const report={runId:id,newPaymentRequests:0,viewports:[],errors:[]};
try{
 const context=await browser.newContext({viewport:{width:1440,height:1040}}),page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 const token=(await readFile('state/agents/operator/operator-token','utf8')).trim();await page.goto(`${origin}/workspace#token=${token}`);await page.waitForFunction(()=>document.body.classList.contains('agent-mode'));
 const before=await page.evaluate(()=>api('/api/agent-setup'));await page.evaluate(id=>sessionStorage.setItem('mandate.agent-run.selected.v1',id),id);await page.reload();await page.locator('#agentRunDetail .agent-report-body').waitFor();
 const detail=await page.evaluate(id=>api(`/api/agent-runs/${id}`),id);assert.ok(detail.report.receipts.length>0);assert.ok(detail.report.receipts.every(r=>r.chainVerified));
 report.state=detail.run.state;report.paidBaseUnits=detail.report.paidBaseUnits;report.receipts=detail.report.receipts.length;
 assert.match(await page.locator('#agentRunDetail .agent-report-body').innerText(),/What remains unknown/);
 await page.locator('#agentRunDetail details[data-group="receipts"] summary').click();
 for(const view of [{name:'desktop',width:1440,height:1040},{name:'mobile',width:390,height:844}]){
  await page.setViewportSize({width:view.width,height:view.height});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${view.name} overflow`);
  const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();const failures=audit.violations.filter(v=>['serious','critical'].includes(v.impact));report.errors.push(...failures.map(v=>`${view.name}: ${v.id}`));
  await page.screenshot({path:`${folder}/${view.name}.png`,fullPage:true});report.viewports.push({name:view.name,horizontalOverflow:false,seriousOrCriticalViolations:failures.length});
 }
 const after=await page.evaluate(()=>api('/api/agent-setup'));assert.equal(after.setup.payments.length,before.setup.payments.length);assert.deepEqual(report.errors,[]);report.passed=true;console.log(JSON.stringify(report,null,2));
}catch(e){report.passed=false;report.error=e.message;console.error(e.stack);process.exitCode=1;}
finally{await writeFile(`${folder}/report.json`,JSON.stringify(report,null,2));await browser.close();}
