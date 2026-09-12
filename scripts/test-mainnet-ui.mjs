#!/usr/bin/env node
/** Real browser -> authenticated HTTP -> adaptive runtime -> stock x402 signing -> SQLite.
 * Model, Ledger hardware and on-chain settlement are simulated. No real funds are used. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';import AxeBuilder from '@axe-core/playwright';
import {privateKeyToAccount} from 'viem/accounts';import {verifyTypedData} from 'viem';
import {encodePaymentRequiredHeader,encodePaymentResponseHeader,decodePaymentSignatureHeader} from '@x402/core/http';
import {createOperatorApp} from '../packages/gateway/src/operator.ts';
import {ExactAgentExecutor,EXACT_USDC} from '../packages/gateway/src/agent-exact.ts';
import {AgentFundingController} from '../packages/gateway/src/agent-funding.ts';
import {AgentReturnController} from '../packages/gateway/src/agent-return.ts';
const dir=await mkdtemp(join(tmpdir(),'mandate-mainnet-e2e-'));const root=resolve(new URL('..',import.meta.url).pathname);
const payer=privateKeyToAccount(`0x${'11'.repeat(32)}`),spending=privateKeyToAccount(`0x${'22'.repeat(32)}`);
const authority={id:'mainnet-fixture',network:'eip155:8453',asset:EXACT_USDC['eip155:8453'],payerAddress:payer.address,spendingAddress:spending.address,expiresAt:Date.now()+3600000,ceilingBaseUnits:'250000',perCallBaseUnits:'20000',windowBaseUnits:'200000',windowMs:3600000,tools:['graph-protocol','crypto-prices'].map(id=>({id,origin:'https://fixture.invalid',pathname:'/tools/'+id,payTo:'0x0000000000000000000000000000000000000002'}))};
let app,executor,funding;let ledgerSignatures=0,paidCalls=0,settlements=0;const errors=[];
const services={authorityId:authority.id,executor:{catalog:()=>executor.catalog(),quote:(...a)=>executor.quote(...a),execute:(...a)=>executor.execute(...a)},
 model:{async next({observations,run}){return{usage:{provider:'fixture',totalTokenCount:0},decision:observations.length<2?{action:'tool',toolId:observations.length?'crypto-prices':'graph-protocol',input:{query:'controlled source'},reason:observations.length?'Corroborate the first observation with another approved source.':'Inspect the primary source.'}:{action:'finish',complete:true,evidenceIds:observations.map(o=>o.requestId),result:'# Verified fixture result\n\nTwo controlled sources were used. This is a simulated mainnet payment test, not a live receipt.\n\n<script>window.injected=true</script>'}};}},
 readiness:()=>({ready:funding?.review().funding.status==='funded',reason:funding?.review().funding.status==='funded'?'Ready for controlled test':'Review funding on Ledger'}),
 inspect:()=>({...funding.review(),configuredTools:executor.catalog(),vertex:{model:'fixture'},payments:app.journal.requests(authority.id).map(r=>({id:r.id,state:r.state,network:r.network,amountBaseUnits:r.charged??r.maximum,transaction:r.receipt?JSON.parse(r.receipt).transaction:null,chainVerified:r.state==='accepted'}))})};
let browser;const proof={liveFunds:false,realHardware:false,checks:[],screenshots:[]};
try{
 app=await createOperatorApp({root,dataDir:dir,port:0,agentServices:services});
 executor=new ExactAgentExecutor({authority,journal:app.journal,tools:authority.tools.map(t=>({id:t.id,description:'Controlled evidence source',inputSchema:{type:'object'},request:input=>({url:t.origin+t.pathname,method:'POST',body:JSON.stringify(input)}),sources:()=>[{url:'https://example.org/source',title:'Controlled source'}]})),signer:spending,verify:async()=>{},fetch:async(url,init)=>{
  const offer={scheme:'exact',network:authority.network,asset:authority.asset,amount:'1000',payTo:authority.tools[0].payTo,maxTimeoutSeconds:120,extra:{name:'USD Coin',version:'2',assetTransferMethod:'eip3009'}};
  const signature=new Headers(init.headers).get('payment-signature');if(!signature)return new Response(null,{status:402,headers:{'payment-required':encodePaymentRequiredHeader({x402Version:2,resource:{url:String(url)},accepts:[offer]})}});
  const payload=decodePaymentSignatureHeader(signature);assert.equal(payload.accepted.network,'eip155:8453');paidCalls++;
  return new Response(JSON.stringify({source:'controlled evidence',value:1}),{headers:{'payment-response':encodePaymentResponseHeader({success:true,network:authority.network,transaction:`0x${'ab'.repeat(32)}`})}});
 }});
 const facilitator={getSupported:async()=>({kinds:[{x402Version:2,scheme:'exact',network:authority.network}],extensions:[],signers:{}}),verify:async()=>({isValid:true,payer:payer.address}),settle:async()=>{settlements++;return{success:true,network:authority.network,transaction:`0x${'cd'.repeat(32)}`,payer:payer.address};}};
 funding=new AgentFundingController({authority,journal:app.journal,rpcUrl:'https://mainnet.base.org',facilitatorUrl:'https://fixture.invalid',signer:async()=>({address:payer.address,signTypedData:async p=>{assert.equal(Number(p.domain.chainId),8453);assert.equal(p.domain.name,'USD Coin');ledgerSignatures++;return payer.signTypedData(p);}}),chain:{chainId:async()=>8453,balance:async()=>1000000n,block:async()=>10n,findTransaction:async()=>`0x${'cd'.repeat(32)}`},facilitator,verify:async()=>{}});services.funding=funding;
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${app.server.address().port}`;
 browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const token=(await readFile(join(dir,'operator-token'),'utf8')).trim();await page.goto(origin+'/#token='+token);await page.waitForSelector('body.is-connected');await page.waitForFunction(()=>document.querySelector('#agentAllowanceSummary').textContent.includes('Approve'));
 assert.equal(ledgerSignatures,0);assert.equal(paidCalls,0);
 await page.locator('nav [data-navigate="authority"]').click();await page.locator('#agentReviewFunding').click();await page.locator('#agentFundingConsent').check();await page.locator('#agentConfirmFunding').click();
 await page.waitForFunction(()=>document.querySelector('#agentHomeRemaining').textContent==='0.25');assert.equal(ledgerSignatures,1);assert.equal(settlements,1);proof.checks.push('Explicit funding review signs once; correct mainnet chain and USD Coin domain; allowance enabled after verification.');
 await page.locator('nav [data-navigate="agents"]').click();await page.locator('.agent-card').filter({has:page.getByRole('heading',{name:'Protocol Investigator',exact:true})}).getByRole('button',{name:'Use agent',exact:true}).click();
 await page.locator('#agentLaunchGoal').fill('Compare two controlled sources and report what their evidence supports.');await page.locator('#launchAgent').click();await page.waitForSelector('#agentRunDetail .agent-report-body');
 assert.equal(paidCalls,2);assert.equal(await page.evaluate(()=>window.injected),undefined);assert.equal(await page.locator('[data-view="agents"]:visible').count(),0);
 const snapshot=await page.evaluate(()=>api('/api/agents'));assert.equal(snapshot.runs[0].state,'completed');assert.equal(app.journal.totals(authority.id,3600000).spent,'2000');
 proof.checks.push('Browser launch -> two autonomous paid steps -> cited result and durable 0.002 USDC accounting.');
 await page.reload();await page.waitForSelector('#agentRunDetail .agent-report-body');assert.equal(paidCalls,2);proof.checks.push('Reload restores the result without repeating any payment.');
 for(const route of ['/style.css','/index.html','/mandate-sculpture.png'])assert.equal((await page.request.get(origin+route)).status(),404);
 const retired=await page.evaluate(()=>api('/api/config',{}).catch(e=>e.status));assert.equal(retired,410);proof.checks.push('Retired assets and old operator mutation routes are unavailable.');
 await mkdir(join(root,'.live-results/mainnet/e2e'),{recursive:true});
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
  await page.setViewportSize(viewport);
  for(const view of ['home','agents','history','authority','evidence','settings']){
   await page.locator(`nav [data-navigate="${view}"]`).click();assert.equal(await page.locator('[data-view]:visible').count(),1);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),view+' horizontal overflow at '+viewport.width+': '+JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth).slice(0,10).map(e=>({tag:e.tagName,id:e.id,class:e.className,right:e.getBoundingClientRect().right})))));
   const path=join(root,`.live-results/mainnet/e2e/${viewport.width}-${view}.png`);await page.screenshot({path,fullPage:true});proof.screenshots.push(path);
   const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();const serious=audit.violations.filter(v=>['critical','serious'].includes(v.impact));assert.deepEqual(serious.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[],`${view} accessibility`);
  }
 }
 assert.deepEqual(errors,[]);proof.checks.push('All six sidebar views checked at desktop and mobile sizes: one visible panel, no horizontal overflow, no serious accessibility or browser errors.');
 console.log(JSON.stringify(proof,null,2));
}finally{await writeFile(join(root,'.live-results/mainnet/e2e-proof.json'),JSON.stringify({...proof,errors},null,2));await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});}
