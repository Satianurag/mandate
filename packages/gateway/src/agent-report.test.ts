import {test} from 'node:test';import assert from 'node:assert/strict';import {Journal} from './journal.ts';import {AgentStore} from './agent-store.ts';
import {buildAgentReport,agentReportToMarkdown,receiptExplorer,formatTestUsdc} from './agent-report.ts';
test('reports derive confirmed and reserved amounts from actual payment rows, not model prose',()=>{
 const journal=new Journal(':memory:');try{
  const store=new AgentStore(journal.db),run=store.createRun({id:'report-fixture',agentId:'protocol-investigator',goal:'A controlled report test',authorityId:'fixture'});
  store.finish(run.id,'partial','The model cannot decide its own accounting.');
  store.event(run.id,'tool_observation',{requestId:'paid',toolId:'graph-protocol',data:{fixture:true},sources:[{url:'https://example.org/source',title:'Source'},{url:'javascript:alert(1)',title:'Not a source'}],receipt:{network:'eip155:84532',asset:'USDC',amountBaseUnits:'1000',transaction:`0x${'ab'.repeat(32)}`}});
  store.event(run.id,'model_usage',{provider:'vertex',model:'gemini-3.5-flash',totalTokenCount:200,billedThroughX402:false});
  const report=buildAgentReport(store.run(run.id)!,store.events(run.id),[
   {id:'paid',state:'accepted',network:'eip155:84532',asset:'USDC',amountBaseUnits:'1000',transaction:`0x${'ab'.repeat(32)}`,chainVerified:true,error:null,createdAt:1},
   {id:'pending',state:'uncertain',network:'hedera:testnet',asset:'0.0.429274',amountBaseUnits:'2000',transaction:null,chainVerified:false,error:'Unknown outcome',createdAt:2},
  ]);
  assert.equal(report.paidBaseUnits,'1000');assert.equal(report.reservedBaseUnits,'2000');assert.equal(report.inference.totalTokens,200);assert.equal(report.sources.length,1);
  const markdown=agentReportToMarkdown(report);assert.match(markdown,/0\.001 test USDC/);assert.match(markdown,/0\.002 test USDC/);assert.match(markdown,/Base|eip155:84532/);assert.doesNotMatch(markdown,/javascript:/);
 }finally{journal.close();}
});
test('explorer links never resolve to mainnet or an arbitrary supplied URL',()=>{assert.equal(receiptExplorer('eip155:8453',`0x${'ab'.repeat(32)}`),null);assert.equal(receiptExplorer('hedera:testnet','https://attacker.invalid'),null);assert.match(receiptExplorer('hedera:testnet','0.0.5-1789171200-000000001')!,/hashscan.io\/testnet/);assert.equal(formatTestUsdc('1'),'0.000001');assert.equal(formatTestUsdc('123456789'),'123.456789');});
