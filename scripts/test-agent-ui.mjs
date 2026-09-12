#!/usr/bin/env node
/** Browser checks against the actual isolated operator. Never requests funding or starts paid work. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';import {existsSync} from 'node:fs';import {resolve,join} from 'node:path';
import {chromium} from '@playwright/test';import AxeBuilder from '@axe-core/playwright';
const root=resolve(new URL('..',import.meta.url).pathname),origin='http://127.0.0.1:8420',evidence=join(root,'.live-results/agent-integration/browser');
await mkdir(evidence,{recursive:true});
const token=(await readFile(join(root,'state/agents/operator/operator-token'),'utf8')).trim();
const browser=await chromium.launch(existsSync('/Applications/Google Chrome.app')?{channel:'chrome',headless:true}:{headless:true});
const report={checkedAt:new Date().toISOString(),fundingRequested:false,paidRunsStarted:0,checks:[],screenshots:[],errors:[]};
try{
 const context=await browser.newContext({viewport:{width:1440,height:1040}}),page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(`${origin}/workspace#token=${token}`);await page.waitForFunction(()=>document.body.classList.contains('agent-mode'));
 const setup=await page.evaluate(()=>api('/api/agent-setup'));
 assert.ok(setup.setup.authority.id);assert.equal(setup.setup.authority.network,'eip155:84532');
 const data=await page.evaluate(()=>api('/api/agents'));assert.deepEqual(data.availableTools.sort(),['crypto-prices','graph-agent0','graph-protocol','hedera-analysis'].sort());
 report.checks.push('The real operator loads the immutable testnet authority and only four configured services.');
 for(const viewport of [{name:'desktop',width:1440,height:1040},{name:'mobile',width:390,height:844}]){
  await page.setViewportSize({width:viewport.width,height:viewport.height});
  for(const [view,heading]of [['home','agentHomeTitle'],['task','agentsTitle'],['authority','agentAllowanceTitle'],['history','agentHistoryTitle'],['evidence','agentReceiptsTitle']]){
   await page.locator(`nav [data-navigate="${view}"]`).click();await page.locator(`#${heading}`).waitFor();await page.waitForTimeout(100);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${viewport.name}/${view}: page overflow`);
   const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
   const serious=audit.violations.filter(v=>['critical','serious'].includes(v.impact));
   if(serious.length)report.errors.push(...serious.map(v=>`${viewport.name}/${view}: ${v.id} ${v.nodes.map(n=>n.target.join(' ')).join('; ')}`));
   const image=join(evidence,`${viewport.name}-${view}.png`);await page.screenshot({path:image,fullPage:true});report.screenshots.push(image);
  }
 }
 await page.setViewportSize({width:1440,height:1040});await page.locator('nav [data-navigate="task"]').click();
 await page.getByRole('button',{name:'Create an agent',exact:false}).filter({hasText:'Describe the job'}).click();await page.locator('#agentEditor').waitFor();
 assert.equal(await page.locator('#agentToolChoices input[value="web-search"]').isDisabled(),true);
 assert.equal(await page.locator('#agentToolChoices input[value="graph-protocol"]').isChecked(),true);
 const dialogAudit=await new AxeBuilder({page}).include('#agentEditor').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
 report.errors.push(...dialogAudit.violations.filter(v=>['critical','serious'].includes(v.impact)).map(v=>`editor: ${v.id}`));
 await page.locator('#agentName').fill('Evidence cross-check');await page.locator('#agentDescription').fill('A saved custom goal, not a fixed sequence.');
 await page.locator('#agentGoal').fill('Investigate Uniswap V3 on Base. Identify data-quality concerns and explain what the available evidence cannot establish.');
 await page.locator('#agentInstructions').fill('Choose each next permitted tool from the preceding evidence. Investigate anomalous figures and avoid unnecessary calls. Do not invent facts or claim that all USD valuations are trustworthy.');
 await page.locator('#agentOutput').fill('A sourced report with observed facts, data-quality checks, limitations and actual x402 receipts.');
 const existing=data.agents.find(a=>!a.template&&a.name==='Evidence cross-check');
 if(!existing){await page.locator('#agentEditorForm button[type="submit"]').click();await page.locator('#agentEditor').waitFor({state:'hidden'});report.checks.push('A custom agent was saved through the real UI without granting spending authority.');}
 else await page.locator('#closeAgentEditor').click();
 await page.reload();await page.waitForFunction(()=>document.body.classList.contains('agent-mode'));await page.locator('nav [data-navigate="task"]').click();await page.getByRole('heading',{name:'Evidence cross-check',exact:true}).waitFor();
 report.checks.push('Saved custom-agent configuration survives a page reload.');
 const before=await page.evaluate(()=>api('/api/agent-setup'));
 if(before.setup.funding.status==='none'){
  await page.locator('nav [data-navigate="authority"]').click();await page.locator('#agentReviewFunding').click();await page.locator('#agentFundingDialog').waitFor();
  assert.match(await page.locator('#agentFundingReviewText').innerText(),/0\.25 test USDC.*not a mainnet/);
  assert.equal(await page.locator('#agentFundingConsent').isChecked(),false);
  await page.locator('#closeAgentFunding').click();
  const after=await page.evaluate(()=>api('/api/agent-setup'));assert.equal(after.setup.funding.status,'none');
  report.checks.push('Opening and dismissing the exact funding review does not sign, fund or change the allowance.');
 }
 assert.deepEqual(report.errors,[]);report.passed=true;
 console.log(JSON.stringify({passed:true,checks:report.checks,screenshots:report.screenshots.length},null,2));
}catch(e){report.passed=false;report.error=e.message;console.error(e.stack);process.exitCode=1;}
finally{await writeFile(join(evidence,'report.json'),JSON.stringify(report,null,2));await browser.close();}
