/** Exact-wallet recovery fixtures use deterministic local keys and fake settlement. */
import {test} from 'node:test';import assert from 'node:assert/strict';import {privateKeyToAccount} from 'viem/accounts';
import {Journal} from './journal.ts';import {AgentReturnController} from './agent-return.ts';import {EXACT_USDC,type ExactAgentAuthority} from './agent-exact.ts';
const payer=privateKeyToAccount(`0x${'11'.repeat(32)}`),spending=privateKeyToAccount(`0x${'22'.repeat(32)}`),hash=`0x${'bc'.repeat(32)}`;
function fixture(t:{after:(fn:()=>void)=>void},options:{ambiguous?:boolean;balance?:string}={}){
 const journal=new Journal(':memory:');t.after(()=>journal.close());
 const a:ExactAgentAuthority={id:'test-return',network:'eip155:84532',asset:EXACT_USDC['eip155:84532'],payerAddress:payer.address,spendingAddress:spending.address,expiresAt:Date.now()+60000,ceilingBaseUnits:'250000',perCallBaseUnits:'250000',windowBaseUnits:'250000',windowMs:60000,tools:[{id:'graph-protocol',origin:'http://127.0.0.1:8425',pathname:'/tools/graph-protocol',payTo:payer.address}]};
 journal.register(a.id,a);journal.bindIdentity(a.id,a.payerAddress,a.spendingAddress);journal.depositOnce(a.id);journal.funded(a.id,{hermeticFixture:true});
 const calls={sign:0,settle:0,verify:0};const controller=new AgentReturnController({authority:a,journal,rpcUrl:'https://sepolia.base.org',facilitatorUrl:'http://127.0.0.1:8426',
 signer:{address:spending.address,signTypedData:async p=>{calls.sign++;return spending.signTypedData(p);}},
 chain:{chainId:async()=>84532,balance:async()=>({amount:options.balance??'248000',block:'100'}),findTransaction:async()=>hash},
 facilitator:{verify:async()=>({isValid:true,payer:spending.address}),settle:async()=>{calls.settle++;if(options.ambiguous)throw new Error('Controlled lost return response');return{success:true,network:a.network,transaction:hash};}},
 verify:async({offer,payer:from})=>{calls.verify++;assert.equal(offer.payTo,payer.address);assert.equal(from,spending.address);}});
 return{controller,journal,a,calls};
}
test('a return review does not stop or sign; changed consent cannot authorize a transfer',async t=>{const f=fixture(t);const review=await f.controller.preview();assert.equal(review.to,payer.address);assert.equal(review.amountBaseUnits,'248000');assert.equal(f.journal.mandate(f.a.id)?.state,'active');await assert.rejects(f.controller.returnUnused('different'),/changed/);assert.equal(f.calls.sign,0);});
test('unused funds return only to the original payer and permanently close the authority after chain verification',async t=>{const f=fixture(t);await f.controller.returnUnused((await f.controller.preview()).consentHash);assert.equal(f.journal.mandate(f.a.id)?.state,'closed');assert.deepEqual(f.calls,{sign:1,settle:1,verify:1});await assert.rejects(f.controller.preview(),/open/);assert.equal(f.journal.verifyEventChain(),true);});
test('an uncertain return holds the stopped authority and reconciles without repeating the transfer',async t=>{const f=fixture(t,{ambiguous:true});await assert.rejects(f.controller.returnUnused((await f.controller.preview()).consentHash),/lost return/);assert.equal(f.journal.mandate(f.a.id)?.state,'stopped');await assert.rejects(f.controller.preview(),/reconcile/);await f.controller.reconcile();assert.equal(f.journal.mandate(f.a.id)?.state,'closed');assert.deepEqual(f.calls,{sign:1,settle:1,verify:1});});
test('unresolved service signatures prevent returning the wallet balance',async t=>{const f=fixture(t);f.journal.reserve({id:'unresolved',mandateId:f.a.id,digest:'intent',network:f.a.network,asset:f.a.asset,amount:'1000',limits:f.a});f.journal.signed('unresolved',{fixture:true});await assert.rejects(f.controller.preview(),/Reconcile/);assert.equal(f.calls.sign,0);});
test('an unexplained empty wallet is not falsely marked as refunded or safely closed',async t=>{const f=fixture(t,{balance:'0'});await assert.rejects(f.controller.returnUnused((await f.controller.preview()).consentHash),/not explained/);assert.notEqual(f.journal.mandate(f.a.id)?.state,'closed');assert.equal(f.calls.sign,0);});
test('a fully accounted-for zero balance closes without manufacturing a zero-value transfer',async t=>{const f=fixture(t,{balance:'0'});f.journal.reserve({id:'all-spent',mandateId:f.a.id,digest:'intent',network:f.a.network,asset:f.a.asset,amount:'250000',limits:f.a});f.journal.signed('all-spent',{fixture:true});f.journal.accept('all-spent','250000',{transaction:hash,chainVerified:true});const result=await f.controller.returnUnused((await f.controller.preview()).consentHash);assert.equal(result.transaction,null);assert.equal(f.journal.mandate(f.a.id)?.state,'closed');assert.deepEqual(f.calls,{sign:0,settle:0,verify:0});});
test('a confirmed Ledger allowance increase is included in the safe return ceiling',async t=>{
 const f=fixture(t,{balance:'348000'});
 f.journal.db.prepare("INSERT INTO agent_allowance_increases(id,mandate_id,state,amount,resulting_ceiling,consent_hash,transaction_hash,created_at) VALUES('inc-1',?,'confirmed','100000','350000','consent',?,?)").run(f.a.id,hash,Date.now());
 const review=await f.controller.preview();assert.equal(review.approvedFundingBaseUnits,'350000');assert.equal(review.amountBaseUnits,'348000');
 await f.controller.returnUnused(review.consentHash);assert.equal(f.journal.mandate(f.a.id)?.state,'closed');assert.deepEqual(f.calls,{sign:1,settle:1,verify:1});
});
test('unapproved extra wallet funds are still rejected when no Ledger increase exists',async t=>{
 const f=fixture(t,{balance:'260000'});await assert.rejects(f.controller.preview(),/more than the approved Ledger funding/);assert.equal(f.calls.sign,0);
});
