/** Adapted from x402-agentic-orchestrator/report-to-markdown: deterministic receipts and sources, not model-authored accounting. */
import type {AgentRun,AgentEvent} from './agent-store.ts';
import type {ToolObservation} from './agent-runtime.ts';
export interface AgentPaymentView {id:string;state:string;network:string;asset:string;amountBaseUnits:string;transaction:string|null;chainVerified:boolean;error:string|null;createdAt:number}
export function receiptExplorer(network:string,transaction:string):string|null {
  if(network==='eip155:8453'&&/^0x[0-9a-fA-F]{64}$/.test(transaction))return `https://basescan.org/tx/${transaction}`;
  if(network==='hedera:mainnet'&&/^0\.0\.\d+[-@]\d+[-.]\d{1,9}$/.test(transaction))return `https://hashscan.io/mainnet/transaction/${encodeURIComponent(transaction)}`;
  return null;
}
export function formatTestUsdc(units:string):string {const n=BigInt(units),fraction=(n%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return `${n/1000000n}${fraction?'.'+fraction:''}`;}
export function buildAgentReport(run:AgentRun,events:AgentEvent[],payments:AgentPaymentView[]){
  const evidence=new Map<string,ToolObservation>();
  for(const e of events){if(e.kind==='tool_observation') {const value=e.data as ToolObservation;evidence.set(value.requestId,value);}if(e.kind==='payment_reconciled'){const value=(e.data as {observation:ToolObservation}).observation;evidence.set(value.requestId,value);}}
  const sources=new Map<string,{url:string;title:string}>();for(const item of evidence.values())for(const source of item.sources){try{const u=new URL(source.url);if(u.protocol==='https:'&&!u.username&&!u.password)sources.set(u.toString(),{url:u.toString(),title:source.title});}catch{}}
  const usages=events.filter(e=>e.kind==='model_usage'&&(e.data as {provider?:string}).provider!=='approved-plan').map(e=>e.data as Record<string,unknown>);
  const receipts=payments.map(p=>({...p,explorerUrl:p.transaction?receiptExplorer(p.network,p.transaction):null}));
  const paid=payments.filter(p=>p.state==='accepted').reduce((sum,p)=>sum+BigInt(p.amountBaseUnits),0n);
  const reserved=payments.filter(p=>['reserved','signed','uncertain'].includes(p.state)).reduce((sum,p)=>sum+BigInt(p.amountBaseUnits),0n);
  return {version:1,title:run.agent.name,goal:run.goal,status:run.state,result:run.result,error:run.error,runId:run.id,generatedAt:run.updatedAt,
    paidBaseUnits:String(paid),reservedBaseUnits:String(reserved),budgetBaseUnits:run.agent.budgetBaseUnits,
    sources:[...sources.values()],receipts,evidence:[...evidence.values()],evidenceWarnings:[...new Set([...evidence.values()].flatMap(o=>{const d=o.data&&typeof o.data==='object'?o.data as Record<string,unknown>:{};return Array.isArray(d.flags)?d.flags.filter((f):f is string=>typeof f==='string'):[];}))],
    inference:{provider:'vertex',models:[...new Set(usages.map(u=>u.model).filter(Boolean))],calls:usages.reduce((sum,u)=>sum+Number(u.requestCount??1),0),usageIncomplete:usages.some(u=>u.usageIncomplete)||Boolean(run.error?.includes('Vertex')&&!usages.some(u=>u.failed)),totalTokens:usages.reduce((sum,u)=>sum+Number(u.totalTokenCount??0),0),billedThroughX402:false},
    recoveredAfterRun:events.some(e=>e.kind==='payment_reconciled'),reportRecovered:events.some(e=>e.kind==='report_recovered'),
    boundary:'Payments use real USDC on Base mainnet. The model chooses actions; only the trusted broker can authorize a bounded payment. Vertex inference is billed separately.'};
}
const escapeMd=(text:string)=>text.replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ').replace(/</g,'&lt;').replace(/>/g,'&gt;');
export function agentReportToMarkdown(doc:ReturnType<typeof buildAgentReport>):string{
 const parts=[`# ${escapeMd(doc.title)}`,'',`**Goal:** ${escapeMd(doc.goal)}`,`**Status:** ${doc.status} | **Run:** ${doc.runId}`,`**Observed:** ${new Date(doc.generatedAt).toISOString()}`,`**Confirmed service payments:** ${formatTestUsdc(doc.paidBaseUnits)} USDC | **Reserved / uncertain:** ${formatTestUsdc(doc.reservedBaseUnits)} USDC`,'',doc.boundary,'','## Result','',doc.result?.replace(/</g,'&lt;').replace(/>/g,'&gt;')??'No result was produced.'];
 if(doc.error)parts.push('',`> ${escapeMd(doc.error)}`);
 if(doc.recoveredAfterRun)parts.push('','A payment receipt was recovered after execution stopped. The investigation was not automatically rerun or reclassified as complete.');
 parts.push('','## Payment receipts','','| Request | Network | State | Amount (USDC) | Chain proof |','| --- | --- | --- | --- | --- |');
 for(const r of doc.receipts)parts.push(`| ${escapeMd(r.id)} | ${escapeMd(r.network)} | ${escapeMd(r.state)} | ${formatTestUsdc(r.amountBaseUnits)} | ${r.explorerUrl&&r.chainVerified?`[Verified transfer](${r.explorerUrl})`:'Not confirmed'} |`);
 parts.push('','## Sources','');
 for(const source of doc.sources)parts.push(`- [${escapeMd(source.title).replace(/[\[\]]/g,'')}](${source.url.replace(/\)/g,'%29')})`);
 parts.push('','## Model usage','',`${doc.inference.calls} recorded model calls; ${doc.inference.totalTokens} reported tokens. Models: ${doc.inference.models.join(', ')||'none'}. Cloud billing is separate; no dollar cost is inferred from token counts.`);
 if(doc.inference.usageIncomplete)parts.push('','Some failed model requests have no retained usage metadata. Reported tokens are not a complete bill.');
 return parts.join('\n').trim()+'\n';
}
