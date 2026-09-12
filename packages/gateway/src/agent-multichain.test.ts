/** Hermetic protocol tests. Fake settlement transport; no live keys, accounts or payments. */
import {test} from 'node:test';import assert from 'node:assert/strict';
import {PrivateKey,TransferTransaction,TransactionId,AccountId} from '@x402/hedera';
import {privateKeyToAccount} from 'viem/accounts';import {encodePaymentRequiredHeader,encodePaymentResponseHeader,decodePaymentSignatureHeader} from '@x402/core/http';
import {Journal} from './journal.ts';import {AgentStore} from './agent-store.ts';import {ExactAgentExecutor,EXACT_USDC,type ExactAgentAuthority} from './agent-exact.ts';
import {createAgentTools} from './agent-tools.ts';import {assertHederaPayload} from './agent-hedera.ts';import type {PaymentRequirements} from '@x402/core/types';
function fixture(t:{after:(f:()=>void)=>void},loseResponse=false, loseCache=false){
 const journal=new Journal(':memory:');t.after(()=>journal.close());const store=new AgentStore(journal.db),account=privateKeyToAccount(`0x${'33'.repeat(32)}`);
 const scope={accountId:'0.0.5001',payTo:'0.0.5002',feePayer:'0.0.5003',endpoint:'http://127.0.0.1:8423/tools/hedera-analysis'};
 const authority:ExactAgentAuthority={id:'multi-chain-fixture',network:'eip155:84532',asset:EXACT_USDC['eip155:84532'],payerAddress:account.address,spendingAddress:account.address,expiresAt:Date.now()+3600000,ceilingBaseUnits:'3000',perCallBaseUnits:'2000',windowBaseUnits:'3000',windowMs:60000,hedera:scope,
 tools:[{id:'graph-protocol',origin:'http://127.0.0.1:8425',pathname:'/tools/graph-protocol',payTo:'0x0000000000000000000000000000000000000002'}]};
 const config={protocols:[{id:'protocol',label:'Controlled fixture',endpoint:'https://gateway.thegraph.com/api/x402/subgraphs/id/GqzP4Xaehti8KSfQmv3ZctFSjnSUYZ4En5NRsiTbvZpz',queries:[{id:'overview',description:'Fixture',query:'{ factories(first:1) { id } }'}]}],testnetEndpoints:{'graph-protocol':'http://127.0.0.1:8425/tools/graph-protocol','hedera-analysis':scope.endpoint}};
 const counts={evmSignatures:0,hederaSignatures:0,paidRequests:0,lookups:0,verified:0};let saved:{body:string;header:string}|null=null;
 const offerFor=(hedera:boolean):PaymentRequirements=>hedera?{scheme:'exact',network:'hedera:testnet',asset:'0.0.429274',amount:'2000',payTo:scope.payTo,maxTimeoutSeconds:120,extra:{feePayer:scope.feePayer}}:{scheme:'exact',network:authority.network,asset:authority.asset,amount:'1000',payTo:authority.tools[0]!.payTo,maxTimeoutSeconds:120,extra:{name:'USDC',version:'2',assetTransferMethod:'eip3009'}};
 const executor=new ExactAgentExecutor({authority,journal,tools:createAgentTools(config),receiptLookupUrls:Object.values(config.testnetEndpoints),receiptLocator:{checkpoint:async()=>"100",find:async(_payload,_offer,_payer,block)=>{assert.equal(block,"100");return `0x${"aa".repeat(32)}`;}},
 signer:{address:account.address,signTypedData:async p=>{counts.evmSignatures++;return account.signTypedData(p);}},verify:async()=>{counts.verified++;},
 hedera:{signer:{accountId:scope.accountId,createPartiallySignedTransferTransaction:async offer=>{counts.hederaSignatures++;const tx=new TransferTransaction().setTransactionId(TransactionId.generate(scope.feePayer)).setNodeAccountIds([AccountId.fromString('0.0.3')]).setTransactionValidDuration(120).addTokenTransfer('0.0.429274',scope.accountId,-Number(offer.amount)).addTokenTransfer('0.0.429274',scope.payTo,Number(offer.amount)).freeze();await tx.sign(PrivateKey.generateECDSA());return Buffer.from(tx.toBytes()).toString('base64');}},verify:async({scope,offer,payload,transaction})=>{assert.equal(assertHederaPayload(scope,offer,(payload.payload as {transaction:string}).transaction),transaction);counts.verified++;}},
 fetch:(async(url,init)=>{
  const headers=new Headers(init?.headers),hedera=String(url).includes('hedera-analysis'),offer=offerFor(hedera);
  if(headers.get('x-mandate-reconcile')==='1'){counts.lookups++;return saved&&!loseCache?new Response(saved.body,{headers:{'payment-response':saved.header}}):new Response(null,{status:409});}
  const signature=headers.get('payment-signature');
  if(!signature)return new Response(null,{status:402,headers:{'payment-required':encodePaymentRequiredHeader({x402Version:2,resource:{url:String(url)},accepts:[offer]})}});
  counts.paidRequests++;const payload=decodePaymentSignatureHeader(signature);
  const transaction=hedera?assertHederaPayload(scope,offer,(payload.payload as {transaction:string}).transaction):`0x${'aa'.repeat(32)}`;
  saved={body:JSON.stringify({finding:hedera?'Verified data-quality fixture':'Graph fixture',source:{title:'Test evidence',url:'https://example.org/evidence'}}),header:encodePaymentResponseHeader({success:true,network:offer.network,transaction})};
  if(loseResponse)throw new Error('Controlled lost response');return new Response(saved.body,{headers:{'payment-response':saved.header}});
 }) as typeof fetch});
 journal.depositOnce(authority.id);journal.funded(authority.id,{hermeticFixture:true});
 const run=store.createRun({id:'multi-chain-test-run',agentId:'protocol-investigator',goal:'Controlled protocol goal',authorityId:authority.id});
 return {executor,journal,run,counts};
}
test('Base Sepolia and native Hedera share one durable USDC ceiling and preserve their own assets and receipts',async t=>{
 const f=fixture(t),signal=new AbortController().signal;
 const graph=await f.executor.quote('graph-protocol',{sourceId:'protocol',queryId:'overview'},signal);
 await f.executor.execute({run:f.run,quote:graph,requestId:'graph-request',remainingBaseUnits:'100000',signal});
 const native=await f.executor.quote('hedera-analysis',{sourceId:'protocol',mode:'protocol-quality'},signal);
 const observation=await f.executor.execute({run:f.run,quote:native,requestId:'native-request',remainingBaseUnits:'99000',signal});
 assert.equal(observation.receipt.network,'hedera:testnet');assert.equal(f.journal.request('native-request')?.asset,'0.0.429274');assert.equal(f.journal.totals(f.run.authorityId,60000).spent,'3000');
 const excess=await f.executor.quote('graph-protocol',{sourceId:'protocol',queryId:'overview'},signal);
 await assert.rejects(f.executor.execute({run:f.run,quote:excess,requestId:'excess-request',remainingBaseUnits:'97000',signal}),/budget/);
 assert.deepEqual(f.counts,{evmSignatures:1,hederaSignatures:1,paidRequests:2,lookups:0,verified:2});
});
test('a lost native payment response is recovered with the identical exported payload and zero new payment attempts',async t=>{
 const f=fixture(t,true),signal=new AbortController().signal;
 const quote=await f.executor.quote('hedera-analysis',{sourceId:'protocol',mode:'protocol-quality'},signal);
 await assert.rejects(f.executor.execute({run:f.run,quote,requestId:'lost-native',remainingBaseUnits:'100000',signal}),/lost response/);
 assert.equal(f.journal.request('lost-native')?.state,'uncertain');const recovered=await f.executor.reconcile('lost-native');
 assert.equal(recovered.observation.receipt.amountBaseUnits,'2000');assert.equal(f.journal.request('lost-native')?.state,'accepted');
 assert.equal(f.counts.hederaSignatures,1);assert.equal(f.counts.paidRequests,1);assert.equal(f.counts.lookups,1);assert.equal(f.counts.verified,1);
});

test('native chain-only recovery accounts for a confirmed payment without inventing delivery when the merchant cache is lost',async t=>{
 const f=fixture(t,true,true),signal=new AbortController().signal;
 const quote=await f.executor.quote('hedera-analysis',{sourceId:'protocol',mode:'protocol-quality'},signal);
 await assert.rejects(f.executor.execute({run:f.run,quote,requestId:'native-no-cache',remainingBaseUnits:'100000',signal}),/lost response/);
 await assert.rejects(f.executor.reconcile('native-no-cache','0.0.5003-1-000000001'),/differs/);
 assert.equal(f.journal.request('native-no-cache')?.state,'uncertain');
 const recovered=await f.executor.reconcile('native-no-cache');assert.equal(recovered.observation.data,null);assert.match(recovered.observation.error!,/response is unavailable/);
 assert.equal(f.journal.request('native-no-cache')?.state,'accepted');assert.equal(f.counts.hederaSignatures,1);assert.equal(f.counts.paidRequests,1);
});
test('EVM chain-only recovery uses the retained nonce checkpoint and never retries a paid tool',async t=>{
 const f=fixture(t,true,true),signal=new AbortController().signal;
 const quote=await f.executor.quote('graph-protocol',{sourceId:'protocol',queryId:'overview'},signal);
 await assert.rejects(f.executor.execute({run:f.run,quote,requestId:'evm-no-cache',remainingBaseUnits:'100000',signal}),/lost response/);
 const recovered=await f.executor.reconcile('evm-no-cache');assert.equal(recovered.observation.data,null);assert.equal(recovered.observation.sources.length,0);
 assert.equal(f.journal.totals(f.run.authorityId,60000).spent,'1000');assert.equal(f.counts.evmSignatures,1);assert.equal(f.counts.paidRequests,1);
});
