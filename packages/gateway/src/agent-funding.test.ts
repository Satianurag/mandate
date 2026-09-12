import {test} from 'node:test';import assert from 'node:assert/strict';import {privateKeyToAccount} from 'viem/accounts';
import {Journal} from './journal.ts';import {AgentFundingController,type AgentFundingOptions} from './agent-funding.ts';import {EXACT_USDC,type ExactAgentAuthority} from './agent-exact.ts';
const payer=privateKeyToAccount(`0x${'11'.repeat(32)}`),spending=privateKeyToAccount(`0x${'22'.repeat(32)}`),hash=`0x${'ab'.repeat(32)}`;
function setup(options:{settlementFails?:boolean;stopDuringSign?:boolean;balance?:bigint}={}){
 const journal=new Journal(':memory:');
 const authority:ExactAgentAuthority={id:'test-funding-authority',network:'eip155:84532',asset:EXACT_USDC['eip155:84532'],payerAddress:payer.address,spendingAddress:spending.address,expiresAt:Date.now()+3600000,ceilingBaseUnits:'250000',perCallBaseUnits:'20000',windowBaseUnits:'100000',windowMs:3600000,tools:[{id:'graph-protocol',origin:'http://127.0.0.1:8425',pathname:'/tools/graph-protocol',payTo:spending.address}]};
 journal.register(authority.id,authority);journal.bindIdentity(authority.id,payer.address,spending.address);
 const counts={sign:0,settle:0,verify:0,lookup:0};
 const input:AgentFundingOptions={authority,journal,rpcUrl:'https://sepolia.base.org',facilitatorUrl:'http://127.0.0.1:8426',
 signer:async()=>({address:payer.address,signTypedData:async params=>{counts.sign++;if(options.stopDuringSign)journal.stop(authority.id);return payer.signTypedData(params);}}),
 chain:{chainId:async()=>84532,balance:async()=>options.balance??1000000n,block:async()=>1n,findTransaction:async()=>{counts.lookup++;return hash;}},
 facilitator:{getSupported:async()=>({kinds:[{x402Version:2,scheme:'exact',network:'eip155:84532'}],extensions:[],signers:{}}),verify:async()=>({isValid:true,payer:payer.address}),settle:async()=>{counts.settle++;if(options.settlementFails)throw new Error('Lost settlement response');return {success:true,network:'eip155:84532',transaction:hash,payer:payer.address};}},
 verify:async({offer,payer:sender})=>{counts.verify++;assert.equal(offer.payTo,spending.address);assert.ok(['250000','100000'].includes(offer.amount));assert.equal(sender,payer.address);}};
 return {journal,authority,counts,controller:new AgentFundingController(input)};
}
test('funding startup and wrong review cannot sign or transfer',async()=>{const t=setup();assert.deepEqual(t.counts,{sign:0,settle:0,verify:0,lookup:0});await assert.rejects(t.controller.fund('changed'),/review changed/);assert.equal(t.journal.mandate(t.authority.id)?.deposit,'none');t.journal.close();});
test('initial funding uses one verified exact signature and cannot be silently repeated',async()=>{const t=setup();const result=await t.controller.fund(t.controller.review().consentHash);assert.equal(result.transaction,hash);assert.equal(t.journal.mandate(t.authority.id)?.deposit,'funded');await assert.rejects(t.controller.fund(t.controller.review().consentHash),/already|deposit/i);assert.equal(t.counts.sign,1);assert.equal(t.counts.settle,1);assert.equal(t.counts.verify,1);t.journal.close();});
test('an ambiguous funding submission is reconciled without another signature or settlement request',async()=>{const t=setup({settlementFails:true});await assert.rejects(t.controller.fund(t.controller.review().consentHash),/Lost/);assert.equal(t.journal.mandate(t.authority.id)?.deposit,'pending');await t.controller.reconcile();assert.equal(t.journal.mandate(t.authority.id)?.deposit,'funded');assert.equal(t.counts.sign,1);assert.equal(t.counts.settle,1);assert.equal(t.counts.lookup,1);t.journal.close();});
test('insufficient test balance cannot reach a signature and remains retryable',async()=>{const t=setup({balance:1n});await assert.rejects(t.controller.fund(t.controller.review().consentHash),/insufficient/);assert.equal(t.counts.sign,0);assert.equal(t.journal.mandate(t.authority.id)?.deposit,'none');t.journal.close();});
test('stopping while device review is active prevents submission even if the signature returns',async()=>{const t=setup({stopDuringSign:true});await assert.rejects(t.controller.fund(t.controller.review().consentHash),/active|stopped/i);assert.equal(t.counts.sign,1);assert.equal(t.counts.settle,0);assert.equal(t.journal.mandate(t.authority.id)?.state,'stopped');t.journal.close();});
test('an explicit Ledger increase raises only the confirmed lifetime allowance',async()=>{
 const options:{settlementFails?:boolean}={};const t=setup(options);
 await t.controller.fund(t.controller.review().consentHash);
 const review=t.controller.reviewIncrease('100000');
 assert.equal(review.currentCeilingBaseUnits,'250000');assert.equal(review.resultingCeilingBaseUnits,'350000');
 assert.equal(review.unchanged.perCallBaseUnits,t.authority.perCallBaseUnits);assert.equal(review.unchanged.windowBaseUnits,t.authority.windowBaseUnits);assert.equal(review.unchanged.expiresAt,t.authority.expiresAt);
 const result=await t.controller.increase('100000',review.consentHash);assert.equal(result.resultingCeilingBaseUnits,'350000');
 const after=t.controller.review();assert.equal(after.effectiveCeilingBaseUnits,'350000');assert.equal(after.confirmedIncreaseBaseUnits,'100000');assert.equal(after.increases.length,1);
 assert.deepEqual(t.counts,{sign:2,settle:2,verify:2,lookup:0});t.journal.close();
});
test('a stale or oversized increase cannot reach Ledger signing',async()=>{
 const t=setup();await t.controller.fund(t.controller.review().consentHash);const review=t.controller.reviewIncrease('100000');
 await assert.rejects(t.controller.increase('200000',review.consentHash),/review changed/);assert.equal(t.counts.sign,1);
 assert.throws(()=>t.controller.reviewIncrease('5000000'),/cannot exceed 5/);assert.equal(t.counts.sign,1);t.journal.close();
});
test('an ambiguous allowance increase reconciles without a second Ledger signature or settlement request',async()=>{
 const options:{settlementFails?:boolean}={};const t=setup(options);await t.controller.fund(t.controller.review().consentHash);options.settlementFails=true;
 const review=t.controller.reviewIncrease('100000');await assert.rejects(t.controller.increase('100000',review.consentHash),/Lost/);
 assert.equal(t.controller.review().effectiveCeilingBaseUnits,'250000');assert.equal(t.counts.sign,2);assert.equal(t.counts.settle,2);
 await t.controller.reconcileIncrease();assert.equal(t.controller.review().effectiveCeilingBaseUnits,'350000');assert.equal(t.counts.sign,2);assert.equal(t.counts.settle,2);assert.equal(t.counts.lookup,1);t.journal.close();
});
test('agents cannot increase allowance while a service payment is unresolved',async()=>{
 const t=setup();await t.controller.fund(t.controller.review().consentHash);
 t.journal.reserve({id:'pending-service',mandateId:t.authority.id,digest:'pending',network:t.authority.network,asset:t.authority.asset,amount:'1000',limits:t.authority});t.journal.signed('pending-service',{fixture:true});
 assert.throws(()=>t.controller.reviewIncrease('100000'),/pending service payments/i);assert.equal(t.counts.sign,1);t.journal.close();
});
