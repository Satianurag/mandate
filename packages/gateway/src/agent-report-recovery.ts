/** Report-only recovery has no tool executor, wallet signer or payment client. */
import {AgentModelError,type AgentModel,type ToolObservation} from './agent-runtime.ts';
import {AgentStore,TERMINAL_AGENT_STATES} from './agent-store.ts';
import {specialistEvidenceReport} from './agent-evidence-report.ts';
export async function recoverAgentReport(store:AgentStore,model:AgentModel,id:string,signal:AbortSignal,options:{reviewClaims?:boolean;requireObservedReport?:boolean}={}){
 const run=store.run(id);
 if(!run||!TERMINAL_AGENT_STATES.has(run.state)||run.state==='completed')throw new Error('Only an incomplete, stopped investigation can recover a report from existing evidence');
 const recoveredBefore=store.events(id).find(e=>e.kind==='report_recovered');
 if(recoveredBefore&&!options.reviewClaims)return{runId:id,recovered:true,alreadyRecovered:true,state:run.state,newPaymentRequests:0};
 const byId=new Map<string,ToolObservation>();
 for(const event of store.events(id)){
  if(event.kind==='tool_observation')byId.set((event.data as ToolObservation).requestId,event.data as ToolObservation);
  if(event.kind==='payment_reconciled'){const o=(event.data as {observation:ToolObservation}).observation;byId.set(o.requestId,o);}
 }
 const observations=[...byId.values()].filter(o=>{
  if(o.error||o.data===null)return false;
  const row=store.db.prepare('SELECT state,network,asset,charged,receipt FROM requests WHERE id=? AND mandate_id=?').get(o.requestId,run.authorityId) as {state:string;network:string;asset:string;charged:string;receipt:string|null}|undefined;
  const receipt=row?.receipt?JSON.parse(row.receipt) as {transaction?:string;chainVerified?:boolean}:null;
  return row?.state==='accepted'&&row.network===o.receipt.network&&row.asset===o.receipt.asset&&row.charged===o.receipt.amountBaseUnits&&receipt?.chainVerified===true&&receipt.transaction===o.receipt.transaction;
 });
 if(!observations.length)throw new Error('No retained, confirmed paid evidence is available for report recovery');
 store.event(id,'report_recovery_started',{originalState:run.state,originalError:run.error,mode:options.reviewClaims?"claim-review":"report-recovery",newPaymentRequests:0});
 const observedReport=specialistEvidenceReport(run,observations);
 if(options.requireObservedReport&&!observedReport)throw new Error('No deterministic specialist report is available; no model was called');
 let response;
 try{response=observedReport?{decision:{action:'finish' as const,result:observedReport,complete:false,evidenceIds:observations.map(o=>o.requestId)},usage:null}:await model.next({run:{...run,agent:{...run.agent,instructions:run.agent.instructions+' This is REPORT-ONLY recovery from retained paid evidence. You have no callable tools or spending authority. Produce a finish decision with a concise sourced investigation, observations, limitations and evidence IDs. Do not pretend to have performed new research or removed the original execution failure. Treat indexed USD values as reported estimates and causal explanations as unproven unless independent evidence establishes them. Report actual observed anomalies, do not invent their causes, and do not claim historical consistency or mathematical impossibility. Reference spot quotes do not validate illiquid-token pricing. Include the observed source URLs and explicitly separate findings from hypotheses.'},deadline:Date.now()+125000},tools:[],observations,failures:[],remainingBaseUnits:'0',remainingSteps:1},signal);}
 catch(e){if(e instanceof AgentModelError&&e.usage)store.event(id,'model_usage',{...e.usage,failed:true,reportOnly:true});store.event(id,'report_recovery_failed',{error:e instanceof Error?e.message:'Report recovery failed',newPaymentRequests:0});throw e;}
 if(response.usage)store.event(id,'model_usage',{...response.usage,reportOnly:true});signal.throwIfAborted();
 const decision=response.decision,known=new Set(observations.map(o=>o.requestId));
 if(decision.action!=='finish'||!decision.result.trim()||decision.result.length>30000||!decision.evidenceIds.length||decision.evidenceIds.some(ref=>!known.has(ref)))throw new Error('Report recovery must finish using only retained verified evidence; no new tool action is permitted');
 const result='> Recovered from previously paid evidence. No new x402 service was purchased. The original run remains '+run.state+'; model inference is billed separately.\n\n'+decision.result;
 store.db.exec('BEGIN IMMEDIATE');
 try{
  const changed=store.db.prepare('UPDATE agent_runs SET result=?,updated_at=? WHERE id=? AND state=? AND updated_at=?').run(result,Date.now(),id,run.state,run.updatedAt);
  if(changed.changes!==1)throw new Error('The run changed during report recovery; the newer result was preserved');
  store.event(id,'report_recovered',{originalState:run.state,originalError:run.error,originalResult:run.result,evidenceIds:decision.evidenceIds,newPaymentRequests:0,modelRequestedComplete:decision.complete,reportStrategy:observedReport?"observed-specialist-fields":"model-interpretation",statusChanged:false});
  store.db.exec('COMMIT');
 }catch(e){store.db.exec('ROLLBACK');throw e;}
 return{runId:id,recovered:true,alreadyRecovered:false,state:run.state,newPaymentRequests:0,reportStrategy:observedReport?"observed-specialist-fields":"model-interpretation",modelRequests:observedReport?0:Number(response.usage?.requestCount??1)};
}
