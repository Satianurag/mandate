/** Adapted from x402-agentic-orchestrator's plan/estimate/planner-guards flow.
 * Mandate keeps Vertex, integer budgets, reviewed endpoints and durable SQLite authority. */
import {randomUUID} from 'node:crypto';
import type {AgentModel,AgentTool,AgentToolExecutor} from './agent-runtime.ts';
import type {AgentRun} from './agent-store.ts';
import {digest} from './journal.ts';
import {classifyProbeFailure} from './orchestrator/vendor-errors.ts';
export interface AgentPlanStep {toolId:AgentTool['id'];input:Record<string,unknown>;reason:string}
export interface AgentPlan {steps:AgentPlanStep[];reasoning:string}
export interface ReviewedPlan extends AgentPlan {id:string;intentHash:string;estimatedBaseUnits:string;stepPrices:string[];expiresAt:number;modelUsage:Record<string,unknown>}
export function validatePlan(raw:unknown,tools:AgentTool[]):AgentPlan {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Planner did not return a plan');
 const plan=raw as AgentPlan;
 if(!Array.isArray(plan.steps)||plan.steps.length<1||plan.steps.length>19||typeof plan.reasoning!=='string'||plan.reasoning.length>3000)throw new Error('A plan needs one to nineteen useful tool steps');
 const seen=new Set<string>();
 for(const step of plan.steps){
  if(!tools.some(t=>t.id===step.toolId)||!step.input||typeof step.input!=='object'||Array.isArray(step.input)||typeof step.reason!=='string'||!step.reason.trim()||step.reason.length>2000)throw new Error('Planner selected an invalid or unapproved tool action');
  const key=digest({toolId:step.toolId,input:step.input});if(seen.has(key))throw new Error('Plan repeats an identical paid request');seen.add(key);
 }
 return structuredClone(plan);
}
export function planHasBlockingProbeFailures(failures: Array<{ toolId: string; message: string }>): boolean {
 return failures.length > 0;
}
export async function probePlanSteps(executor:AgentToolExecutor,plan:AgentPlan,perCallBaseUnits:string,signal:AbortSignal):Promise<Array<{toolId:string;message:string}>>{
 const failures:Array<{toolId:string;message:string}>=[];
 for(const step of plan.steps){
  try{
   const quote=await executor.quote(step.toolId,step.input,signal);
   if(BigInt(quote.amountBaseUnits)>BigInt(perCallBaseUnits))failures.push({toolId:step.toolId,message:`${step.toolId} exceeds the per-call limit`});
  }catch(error){
   if(signal.aborted)throw error;
   failures.push({toolId:step.toolId,message:classifyProbeFailure(error).userMessage});
  }
 }
 return failures;
}
export async function previewAgentPlan(model:AgentModel,executor:AgentToolExecutor,run:AgentRun,signal:AbortSignal):Promise<ReviewedPlan>{
 if(run.goal.trim().length<12)throw new Error('Describe a specific outcome before buying tool results');
 const tools=executor.catalog().filter(t=>run.agent.toolIds.includes(t.id));
 if(!tools.length)throw new Error('Configure a service for this agent first');
 let plan:AgentPlan,usage:Record<string,unknown>;
 if(model.plan){const result=await model.plan({run,tools,observations:[],failures:[],remainingBaseUnits:run.agent.budgetBaseUnits,remainingSteps:run.agent.maxSteps},signal);plan=validatePlan(result.plan,tools);usage=result.usage;}
 else {const next=await model.next({run,tools,observations:[],failures:[],remainingBaseUnits:run.agent.budgetBaseUnits,remainingSteps:run.agent.maxSteps},signal);if(next.decision.action!=='tool')throw new Error('The goal does not need a paid tool call');plan={steps:[next.decision],reasoning:next.decision.reason};usage=next.usage;}
 if(plan.steps.length>=run.agent.maxSteps)throw new Error('Plan must leave a reasoning step for the final report');
 const failures=await probePlanSteps(executor,plan,run.agent.perCallBaseUnits,signal);
 if(planHasBlockingProbeFailures(failures))throw new Error(`Preflight failed. ${failures.map(f=>f.message).join(' ')}`);
 const prices:string[]=[];
 for(const step of plan.steps){const quote=await executor.quote(step.toolId,step.input,signal);if(BigInt(quote.amountBaseUnits)>BigInt(run.agent.perCallBaseUnits))throw new Error(`${step.toolId} exceeds the per-call limit`);prices.push(quote.amountBaseUnits);}
 const total=prices.reduce((sum,p)=>sum+BigInt(p),0n);if(total>BigInt(run.agent.budgetBaseUnits))throw new Error('The proposed plan exceeds this agent’s run budget');
 return{...plan,id:randomUUID(),intentHash:digest({agent:run.agent,goal:run.goal,authorityId:run.authorityId}),estimatedBaseUnits:String(total),stepPrices:prices,expiresAt:Date.now()+120000,modelUsage:usage};
}
