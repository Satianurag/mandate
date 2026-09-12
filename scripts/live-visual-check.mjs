#!/usr/bin/env node
/** Read-only browser inspection of the completed real run; never replays payment actions. */
import {chromium} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=new URL('..',import.meta.url).pathname,origin='http://127.0.0.1:8410';
const token=(await readFile(`${root}/state/live/operator/operator-token`,'utf8')).trim();
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const report={checkedAt:new Date().toISOString(),financialOperations:0,networkInterceptions:0,checks:[],screenshots:[]};
try{
 await page.goto(`${origin}/workspace#token=${token}`);await page.locator('#workspace').waitFor({state:'visible'});
 assert.equal(new URL(page.url()).hash,'');
 assert.equal(await page.locator('#mandateStatus').innerText(),'Refunded');
 assert.equal(await page.locator('#spent').innerText(),'0.03 USDC');
 assert.equal(await page.locator('#remaining').innerText(),'0.07 USDC returned');
 assert.equal(await page.getByRole('button',{name:'Run paid task',exact:true}).isEnabled(),false);
 assert.equal(await page.locator('#delegate').isEnabled(),false);
 assert.equal(await page.locator('#refund').isEnabled(),false);
 const directory=`${root}/.live-results/repair/visual-final`;await mkdir(directory,{recursive:true});
 for(const viewport of [{name:'desktop',width:1440,height:1000},{name:'mobile',width:390,height:844}]){
  await page.setViewportSize({width:viewport.width,height:viewport.height});
  await page.waitForTimeout(200);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${viewport.name}: horizontal page overflow`);
  const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  const violations=result.violations.map(v=>({id:v.id,impact:v.impact,targets:v.nodes.map(n=>n.target)}));
  const screenshot=`${directory}/${viewport.name}.png`;await page.screenshot({path:screenshot,fullPage:true});
  report.screenshots.push(`.live-results/repair/visual-final/${viewport.name}.png`);report.checks.push({viewport:viewport.name,violations});
  assert.deepEqual(violations,[],`${viewport.name}: accessibility violations`);
 }
 await page.setViewportSize({width:1440,height:1000});
 await page.locator('#result details').first().locator('summary').click();
 await page.locator('#result').screenshot({path:`${directory}/result-receipt.png`});report.screenshots.push(`${directory}/result-receipt.png`);
 assert.deepEqual(errors,[]);report.accounting={authorized:'0.10 USDC',spent:'0.03 USDC',returned:'0.07 USDC',furtherSpendingDisabled:true};report.ok=true;
}catch(error){report.ok=false;report.error=error.message;throw error;}
finally{await mkdir(`${root}/.live-results/repair/visual-final`,{recursive:true});await writeFile(`${root}/.live-results/repair/visual-final/report.json`,JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify(report,null,2));
