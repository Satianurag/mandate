#!/usr/bin/env node
/** Read-only chain validation of retained agent payments. Never creates a signature or submits a transaction. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';import {resolve,join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {chainSettlementVerifier} from '../packages/gateway/src/agent-exact.ts';import {hederaSettlementVerifier} from '../packages/gateway/src/agent-hedera.ts';
import {createPublicClient,http,erc20Abi} from 'viem';
const state=resolve(process.env.MANDATE_OPERATOR_STATE??'state/agents/operator'),config=JSON.parse(await readFile(join(state,'agent-runtime.json'),'utf8'));
const db=new DatabaseSync(join(state,'workspace.sqlite'),{readOnly:true});db.exec('BEGIN');
const proof={checkedAt:new Date().toISOString(),mode:'independent-read-only-chain-verification',authorityId:config.authority.id,networkGuard:'testnet-only',newSignatures:0,newTransactionsSubmitted:0,payments:[]};
try{
 if(config.authority.network!=='eip155:84532')throw new Error('Live verification is restricted to the reviewed testnet authority');
 const verifyEvm=chainSettlementVerifier(config.rpcUrl,config.authority.network),verifyHedera=hederaSettlementVerifier();
 const signatureRow=db.prepare("SELECT data FROM events WHERE mandate_id=? AND kind='deposit.signature_verified' ORDER BY seq DESC LIMIT 1").get(config.authority.id);
 const fundedRow=db.prepare("SELECT data FROM events WHERE mandate_id=? AND kind='agent.funding_confirmed' ORDER BY seq DESC LIMIT 1").get(config.authority.id);
 if(!signatureRow||!fundedRow)throw new Error('No confirmed funding and retained authorization are available');
 const signature=JSON.parse(signatureRow.data),funded=JSON.parse(fundedRow.data);
 await verifyEvm({transaction:funded.transaction,payload:signature.payload,offer:signature.offer,payer:config.authority.payerAddress});
 proof.funding={transaction:funded.transaction,network:config.authority.network,amountBaseUnits:funded.amountBaseUnits,chainVerified:true,ledgerReport:signature.ledgerReport??null};
 const requests=db.prepare("SELECT * FROM requests WHERE mandate_id=? AND state='accepted' ORDER BY created_at").all(config.authority.id);
 for(const request of requests){
  const events=db.prepare('SELECT kind,data FROM events WHERE request_id=? ORDER BY seq DESC').all(request.id);
  const payload=events.filter(e=>e.kind==='request.signed').map(e=>JSON.parse(e.data).payload).find(p=>p?.x402Version===2);
  const intent=JSON.parse(events.find(e=>e.kind==='agent.payment_intent').data),receipt=JSON.parse(request.receipt);
  if(!payload)throw new Error('A payment has no retained complete authorization');
  if(request.network==='hedera:testnet')await verifyHedera({transaction:receipt.transaction,payload,offer:intent.offer,scope:config.authority.hedera});
  else if(request.network==='eip155:84532')await verifyEvm({transaction:receipt.transaction,payload,offer:intent.offer,payer:config.authority.spendingAddress});
  else throw new Error('A payment is outside the reviewed testnets');
  const response=request.response?JSON.parse(request.response):null;
  proof.payments.push({requestId:request.id,toolId:intent.toolId,runId:intent.runId,network:request.network,asset:request.asset,amountBaseUnits:request.charged,transaction:receipt.transaction,chainVerified:true,responseRetained:Boolean(response),responseStatus:response?.status??null});
 }
 proof.totalPaidBaseUnits=String(proof.payments.reduce((sum,p)=>sum+BigInt(p.amountBaseUnits),0n));
 const rpc=createPublicClient({transport:http(config.rpcUrl,{timeout:15000,retryCount:0})});
 proof.spendingWalletBalanceBaseUnits=String(await rpc.readContract({address:config.authority.asset,abi:erc20Abi,functionName:'balanceOf',args:[config.authority.spendingAddress]}));
 const pending=db.prepare("SELECT maximum FROM requests WHERE mandate_id=? AND state IN ('reserved','signed','uncertain')").all(config.authority.id);
 proof.reservedBaseUnits=String(pending.reduce((sum,r)=>sum+BigInt(r.maximum),0n));
 proof.remainingSharedAuthorityBaseUnits=String(BigInt(config.authority.ceilingBaseUnits)-BigInt(proof.totalPaidBaseUnits)-BigInt(proof.reservedBaseUnits));
 proof.note='Wallet balance and shared authority differ because native Hedera payments debit a separate account. A chain-verified charge does not by itself establish a complete investigation.';
 console.log(JSON.stringify(proof,null,2));await mkdir('.live-results/agent-integration',{recursive:true});await writeFile('.live-results/agent-integration/independent-paid-proof.json',JSON.stringify(proof,null,2),{mode:0o600});
}finally{db.close();}
