import {test} from 'node:test';import assert from 'node:assert/strict';import {Journal} from './journal.ts';import {AgentStore} from './agent-store.ts';
import {recoverAgentReport} from './agent-report-recovery.ts';import type {AgentModel} from './agent-runtime.ts';
function fixture(t:{after:(fn:()=>void)=>void}){
 const journal=new Journal(':memory:');t.after(()=>journal.close());const store=new AgentStore(journal.db),limits={ceilingBaseUnits:'10000',perCallBaseUnits:'1000',windowBaseUnits:'10000',windowMs:60000};
 journal.register('authority',limits);const run=store.createRun({id:'recoverable-report',agentId:'protocol-investigator',goal:'Investigate the controlled source',authorityId:'authority'});
 journal.reserve({id:'confirmed-evidence',mandateId:'authority',digest:'fixture',network:'eip155:8453',asset:'USDC',amount:'1000',limits});journal.signed('confirmed-evidence',{fixture:true});journal.accept('confirmed-evidence','1000',{transaction:`0x${'ab'.repeat(32)}`,chainVerified:true});
 store.event(run.id,'tool_observation',{requestId:'confirmed-evidence',toolId:'graph-protocol',data:{fixture:true},sources:[],receipt:{network:'eip155:8453',asset:'USDC',amountBaseUnits:'1000',transaction:`0x${'ab'.repeat(32)}`}});
 store.finish(run.id,'partial','Original incomplete report','Vertex MAX_TOKENS');return{journal,store,run};
}
test('report recovery has no callable tools, preserves execution failure, and is idempotent without new payments',async t=>{
 const f=fixture(t);let calls=0;const model:AgentModel={async next(context){calls++;assert.equal(context.tools.length,0);assert.equal(context.remainingBaseUnits,'0');assert.equal(context.observations.length,1);return{decision:{action:'finish',result:'Observed fixture evidence; further conclusions are not supported.',complete:false,evidenceIds:['confirmed-evidence']},usage:{model:'fixture',totalTokenCount:10}};}};
 await recoverAgentReport(f.store,model,f.run.id,new AbortController().signal);
 assert.equal(f.store.run(f.run.id)?.state,'partial');assert.equal(f.store.run(f.run.id)?.error,'Vertex MAX_TOKENS');assert.match(f.store.run(f.run.id)!.result!,/Recovered from previously paid evidence/);
 assert.equal(f.journal.requests('authority').length,1);assert.equal(f.journal.totals('authority',60000).spent,'1000');
 const again=await recoverAgentReport(f.store,model,f.run.id,new AbortController().signal);assert.equal(again.alreadyRecovered,true);assert.equal(calls,1);
});
test('a report recovery cannot turn a model tool action into a new paid call',async t=>{
 const f=fixture(t);const model:AgentModel={async next(){return{decision:{action:'tool',toolId:'graph-protocol',input:{},reason:'Get more data'},usage:{model:'fixture'}};}};
 await assert.rejects(recoverAgentReport(f.store,model,f.run.id,new AbortController().signal),/no new tool action/);assert.equal(f.store.run(f.run.id)?.result,'Original incomplete report');assert.equal(f.journal.requests('authority').length,1);
});
test('verified specialist fields rebuild the report without any model request',async t=>{
 const f=fixture(t),hash='0.0.5003-1789171200-000000001';
 f.journal.reserve({id:'lab-evidence',mandateId:'authority',digest:'native-fixture',network:'hedera:testnet',asset:'0.0.429274',amount:'1000',limits:{ceilingBaseUnits:'10000',perCallBaseUnits:'1000',windowBaseUnits:'10000',windowMs:60000}});
 f.journal.signed('lab-evidence',{fixture:true});f.journal.accept('lab-evidence','1000',{transaction:hash,chainVerified:true});
 f.store.event(f.run.id,'tool_observation',{requestId:'lab-evidence',toolId:'hedera-analysis',data:{rawSnapshots:{overview:{factories:[]},pools:{pools:[]}},flags:['Controlled valuation warning'],valuationReliable:false},sources:[],receipt:{network:'hedera:testnet',asset:'0.0.429274',amountBaseUnits:'1000',transaction:hash}});
 const model:AgentModel={async next(){throw new Error('A model must not be called for deterministic formatting');}};
 const result=await recoverAgentReport(f.store,model,f.run.id,new AbortController().signal,{requireObservedReport:true});
 assert.equal(result.modelRequests,0);assert.equal(result.reportStrategy,'observed-specialist-fields');assert.match(f.store.run(f.run.id)!.result!,/Indexer-reported value/);assert.equal(f.journal.requests('authority').length,2);
});
test('requiring observed-field recovery cannot silently fall back to a billable model call',async t=>{
 const f=fixture(t);let calls=0;const model:AgentModel={async next(){calls++;throw new Error('Unexpected model call');}};
 await assert.rejects(recoverAgentReport(f.store,model,f.run.id,new AbortController().signal,{requireObservedReport:true}),/no model was called/);assert.equal(calls,0);assert.equal(f.store.run(f.run.id)?.result,'Original incomplete report');
});
