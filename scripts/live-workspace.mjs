#!/usr/bin/env node
/** Exercise the real operator UI. This is an explicit, small TESTNET integration run. */
import {chromium} from '@playwright/test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const action=process.argv[2]??'state';
const root=new URL('..',import.meta.url).pathname;
const directory=process.env.MANDATE_OPERATOR_STATE??`${root}/state/live/operator`;
const origin='http://127.0.0.1:8410';
const token=(await readFile(`${directory}/operator-token`,'utf8')).trim();
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await mkdir(`${root}/.live-results/repair/live-ui`,{recursive:true});
try{
 await page.goto(`${origin}/workspace#token=${token}`);
 await page.locator('#workspace').waitFor({state:'visible'});
 async function state(){return page.evaluate(async()=>{const r=await fetch('/api/state');if(!r.ok)throw new Error('No operator session');return r.json();});}
 let before=await state();
 if(action==='setup'){
   if(before.config)throw new Error('A scope is already configured; refusing to create additional funding authority');
   const offer=JSON.parse(await readFile(`${root}/.live-results/repair/offer.json`,'utf8')).accepts[0];
   const device=JSON.parse(await readFile(`${root}/.live-results/repair/device-readiness.json`,'utf8'));
   assert.equal(offer.network,'eip155:84532');assert.equal(offer.amount,'10000');
   await page.getByRole('button',{name:'Review authority',exact:true}).click();
   for(const [id,value] of Object.entries({operatorAddress:device.payer,receiver:offer.payTo,receiverAuthorizer:offer.extra.receiverAuthorizer,asset:offer.asset,serviceUrl:`${origin.replace('8410','8405')}/analytics`,withdrawDelay:String(offer.extra.withdrawDelay),ceilingInput:'0.10',perCallInput:'0.01',windowInput:'0.03',windowMinutes:'60'}))await page.locator(`#${id}`).fill(value);
   const date=new Date(Date.now()+6*3600000);date.setMinutes(date.getMinutes()-date.getTimezoneOffset());
   await page.locator('#expiresInput').fill(date.toISOString().slice(0,16));
   await page.getByRole('button',{name:'Save reviewed scope',exact:true}).click();
   await page.getByText('Reviewed scope saved. No funds have been authorized or moved.').waitFor();
   before=await state();assert.equal(before.config.ceilingBaseUnits,'100000');assert.equal(before.config.windowBaseUnits,'30000');
   await writeFile(`${root}/.live-results/repair/live-config.json`,JSON.stringify(before.config,null,2));
 }
 if(action==='start'){
   assert.ok(before.config,'Reviewed scope required');
   if(before.tasks.some(t=>t.kind==='query'))throw new Error('A query already exists; poll state instead of creating another Ledger authorization');
   await page.locator('#authorizeFunding').check();
   await page.getByRole('button',{name:'Run paid task',exact:true}).click();
   await page.getByText(/Task .* queued/).waitFor();
 }
 if(action==='run'){
   await page.getByRole('button',{name:'Run paid task',exact:true}).click();await page.getByText(/Task .* queued/).waitFor();
 }
 if(action==='delegate'){
   await page.getByRole('button',{name:'Create scoped agent access',exact:true}).click();await page.getByText(/Scoped agent capability saved privately/).waitFor();
 }
 if(action==='publish'){
   page.once('dialog',d=>d.accept());await page.locator('#publishEvidence').click();await page.getByText(/Evidence publication queued/).waitFor();
 }
 if(action==='reconcile'){
   const reply=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/reconcile',{timeout:30000});await page.locator('#reconcile').click();const response=await reply;const outcome=await response.json();console.log(JSON.stringify({reconciliationStatus:response.status(),outcome},null,2));if(!response.ok())throw new Error(outcome.error??'Reconciliation failed');await page.waitForTimeout(300);
 }
 if(action==='settle'){
   page.once('dialog',d=>d.accept());await page.locator('#settle').click();await page.getByText(/Merchant settlement requested/).waitFor();
 }
 if(action==='stop'){
   await page.getByRole('button',{name:'Stop new work',exact:true}).click();await page.getByText('New work stopped and agent capabilities revoked. Existing payments were not reversed.').waitFor();
 }
 if(action==='refund'){
   await page.getByRole('button',{name:'Request remaining-funds refund',exact:true}).click();await page.locator('#confirmRefund').click();await page.getByText(/Recovery requested/).waitFor();
 }
 const after=await state();
 const report={action,checkedAt:new Date().toISOString(),config:after.config,financial:after.financial,tasks:after.tasks,events:after.events,pageErrors:errors};
 await writeFile(`${root}/.live-results/repair/live-ui/${action}.json`,JSON.stringify(report,null,2));
 await page.screenshot({path:`${root}/.live-results/repair/live-ui/${action}.png`,fullPage:true});
 console.log(JSON.stringify({action,financial:after.financial?{state:after.financial.state,deposit:after.financial.deposit,spent:after.financial.spent,reserved:after.financial.reserved,channelId:after.financial.channelId}:null,tasks:after.tasks.map(t=>({id:t.id,kind:t.kind,state:t.state,error:t.error})),message:await page.locator('#globalMessage').innerText(),pageErrors:errors},null,2));
 assert.deepEqual(errors,[]);
}finally{await browser.close();}
