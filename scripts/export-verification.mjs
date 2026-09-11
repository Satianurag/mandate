#!/usr/bin/env node
/** Export public, independently checkable run facts. Never copy keys, session tokens, or private profiles. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {resolve,join,relative,isAbsolute,sep} from 'node:path';
import {parseMandateFile} from '../packages/gateway/src/mandate-config.ts';
import {Journal,digest} from '../packages/gateway/src/journal.ts';
import {snapshotChannel} from '../packages/gateway/src/reconciliation.ts';
const root=new URL('..',import.meta.url).pathname;
function publicArtifact(value){
 if(Array.isArray(value))return value.map(publicArtifact);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,publicArtifact(item)]));
 if(typeof value==='string'&&isAbsolute(value)){
  const local=relative(root,resolve(value));
  if(local==='..'||local.startsWith(`..${sep}`)||isAbsolute(local))throw new Error('Public proof artifact points outside the repository');
  return local.split(sep).join('/');
 }
 return value;
}
const cfg=parseMandateFile(await readFile(join(root,'state/live/operator/active-mandate.yaml'),'utf8'));
const id=digest({network:cfg.network,salt:cfg.salt});
const financial=new Journal(join(resolve(root,cfg.storageRoot),'broker.sqlite'));
const workspace=new Journal(join(root,'state/live/operator/workspace.sqlite'));
const merchant=new Journal(join(root,'state/live/merchant/merchant.sqlite'));
const taskDb=new DatabaseSync(join(root,'state/live/operator/workspace.sqlite'),{readOnly:true});
try{
 const mandate=financial.mandate(id),events=financial.events(id),requests=financial.requests(id);
 if(!mandate?.channel_id) throw new Error('No verified live mandate channel');
 const tasks=taskDb.prepare('SELECT id,kind,state,result,error FROM workspace_tasks WHERE mandate_id=? ORDER BY created_at').all(id);
 const deposit=events.find(e=>e.kind==='deposit.signature_verified');
 const refund=events.find(e=>e.kind==='refund.transaction_confirmed');
 const settlement=tasks.find(t=>t.kind==='settlement'&&t.state==='succeeded');
 const consensus=JSON.parse(await readFile(join(root,'.live-results/repair/hcs-readback.json'),'utf8'));
 const evidence={
   workspace:{events:workspace.events().length,confirmed:workspace.events().filter(e=>e.anchor_state==='confirmed').length,pending:workspace.pendingCount(),eventChainValid:workspace.verifyEventChain()},
   buyer:{events:events.length,confirmed:events.filter(e=>e.anchor_state==='confirmed').length,pending:financial.pendingCount(),eventChainValid:financial.verifyEventChain()},
   merchant:{events:merchant.events().length,confirmed:merchant.events().filter(e=>e.anchor_state==='confirmed').length,pending:merchant.pendingCount(),eventChainValid:merchant.verifyEventChain()},
   consensusReadback:{network:consensus.network,topic:consensus.topic,independentlyVerified:consensus.verified?.length??0,failures:consensus.failures?.length??0,pending:consensus.pending??0},
 };
 const proof={format:'mandate-live-proof-v2',generatedAt:new Date().toISOString(),testnetOnly:true,
   authority:{network:cfg.network,payer:cfg.operatorAddress,receiver:cfg.receiver,asset:cfg.asset,receiverAuthorizer:cfg.receiverAuthorizer,channelId:mandate.channel_id,
     ceilingBaseUnits:cfg.ceilingBaseUnits,perCallBaseUnits:cfg.perCallBaseUnits,windowBaseUnits:cfg.windowBaseUnits,windowMs:cfg.windowMs,expiresAt:cfg.expiresAt},
   financial:{state:mandate.state,...financial.totals(id,cfg.windowMs),returnedBaseUnits:refund?JSON.parse(refund.data).returnedBaseUnits:null},
   ledgerFunding:{verifiedSignatureEvents:events.filter(e=>e.kind==='deposit.signature_verified').length,report:deposit?JSON.parse(deposit.data):null},
   payments:requests.map(r=>({id:r.id,state:r.state,amountBaseUnits:r.charged,reservedMaximum:r.maximum,network:r.network,asset:r.asset,receipt:r.receipt?JSON.parse(r.receipt):null,
     result:r.response?JSON.parse(JSON.parse(r.response).body):null})),
   tasks:tasks.map(t=>({id:t.id,kind:t.kind,state:t.state,error:t.error})),
   merchantSettlement:settlement?.result?JSON.parse(settlement.result):null,
   refund:refund?JSON.parse(refund.data):null,
   currentChainSnapshot:await snapshotChannel({rpcUrl:cfg.rpcUrl,chainId:84532,channelId:mandate.channel_id,asset:cfg.asset,payer:cfg.operatorAddress,receiver:cfg.receiver}),
   evidence,
 };
 for(const [name,file] of [['headless','headless-live.json'],['agentIsolation','agent-isolation.json'],['agentPaid','agent-paid.json'],['consensusReadback','hcs-readback.json'],['visual','visual-final/report.json']]){
   try{proof[name]=publicArtifact(JSON.parse(await readFile(join(root,'.live-results/repair',file),'utf8')));}catch{proof[name]=null;}
 }
 await mkdir(join(root,'docs/verification'),{recursive:true});
 await writeFile(join(root,'docs/verification/live-proof-2026-09-11.json'),JSON.stringify(proof,null,2));
 console.log(JSON.stringify({testnetOnly:proof.testnetOnly,financial:proof.financial,ledgerSignatures:proof.ledgerFunding.verifiedSignatureEvents,
   deposit:proof.payments.map(p=>p.receipt?.transaction).filter(Boolean),settlement:proof.merchantSettlement?.settle?.transaction,refund:proof.refund?.transaction,evidence:proof.evidence},null,2));
}finally{financial.close();workspace.close();merchant.close();taskDb.close();}
