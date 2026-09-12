/** Adaptive goal execution. Payment signing belongs exclusively to the broker executor. */
import { classifyProbeFailure } from "./orchestrator/vendor-errors.ts";
import { digest } from "./journal.ts";
import { randomUUID } from "node:crypto";
import { specialistEvidenceReport } from "./agent-evidence-report.ts";
import { AgentStore, TERMINAL_AGENT_STATES, type AgentRun } from "./agent-store.ts";
import type { AgentToolId } from "./agent-profiles.ts";
import { planHasBlockingProbeFailures, probePlanSteps, type AgentPlan } from "./agent-plan.ts";

export interface AgentTool {
  id: AgentToolId; description: string; inputSchema: Record<string, unknown>;
}
export interface ToolObservation {
  toolId: AgentToolId; requestId: string; data: unknown;
  sources: Array<{ url: string; title: string }>;
  receipt: { network: string; asset: string; amountBaseUnits: string; transaction: string };
  error?: string;
}
export type AgentDecision =
  | { action: "tool"; toolId: AgentToolId; input: Record<string, unknown>; reason: string }
  | { action: "finish"; result: string; complete: boolean; evidenceIds: string[] };
export interface ReasoningContext {
  run: AgentRun; tools: AgentTool[]; observations: ToolObservation[];
  failures: Array<{ toolId: AgentToolId; reason: string }>;
  remainingBaseUnits: string; remainingSteps: number;
}
export interface AgentModel {
  plan?(context: ReasoningContext, signal: AbortSignal): Promise<{ plan: AgentPlan; usage: Record<string, unknown> }>;
  next(context: ReasoningContext, signal: AbortSignal): Promise<{ decision: AgentDecision; usage: Record<string, unknown> }>;
}
export interface X402Quote {
  toolId: AgentToolId; input: Record<string, unknown>; network: string; asset: string;
  amountBaseUnits: string; offerId: string;
}
export interface AgentToolExecutor {
  catalog(): AgentTool[];
  /** Unpaid discovery/quote, with input validation and fixed endpoint mapping. */
  quote(toolId: AgentToolId, input: Record<string, unknown>, signal: AbortSignal): Promise<X402Quote>;
  /** Must atomically enforce shared authority AND run budget before signing.
   * Return only a confirmed payment+response; never blindly retry an uncertain charge. */
  execute(input: { run: AgentRun; quote: X402Quote; requestId: string; remainingBaseUnits: string; signal: AbortSignal }): Promise<ToolObservation>;
}
export class AgentModelError extends Error {
  readonly usage?: Record<string, unknown>;
  constructor(message: string, usage?: Record<string, unknown>) { super(message); this.usage = usage; }
}
export class UncertainAgentPayment extends Error {}
export class AgentAuthorityError extends Error {}
export class ConfirmedPaidToolFailure extends Error {
  readonly observation: ToolObservation;
  constructor(observation: ToolObservation) { super(observation.error ?? "Paid service failed"); this.observation = observation; }
}
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const positiveUnits = (s: unknown): s is string => typeof s === "string" && /^[1-9]\d{0,30}$/.test(s);

export class AgentRuntime {
  readonly store: AgentStore;
  readonly model: AgentModel;
  readonly executor: AgentToolExecutor;
  private readonly active = new Map<string, AbortController>();
  constructor(store: AgentStore, model: AgentModel, executor: AgentToolExecutor) {
    this.store = store; this.model = model; this.executor = executor;
  }
  stop(id: string): void { this.store.stop(id); this.active.get(id)?.abort(new Error("Stopped by user")); }
  async run(id: string): Promise<void> {
    if (!this.store.claim(id)) return;
    const run = this.store.run(id)!;
    const controller = new AbortController(); this.active.set(id, controller);
    const timer = setTimeout(() => controller.abort(new Error("Runtime limit reached")), Math.max(1, run.deadline - Date.now()));
    const signal = controller.signal;
    const observations: ToolObservation[] = [];
    const failures: ReasoningContext["failures"] = [];
    // Restore only chain-confirmed observations, following the reference run checkpoint flow.
    const prior = this.store.events(id);
    const approvedPlan = prior.find(e => e.kind === "plan_approved")?.data as AgentPlan | undefined;
    const retained=new Map<string,ToolObservation>();
    for(const event of prior){
      const observation=event.kind==='tool_observation'?event.data as ToolObservation:event.kind==='payment_reconciled'?(event.data as {observation:ToolObservation}).observation:null;
      if(observation)retained.set(observation.requestId,observation);
    }
    observations.push(...retained.values());
    let spent = observations.reduce((sum, o) => sum + BigInt(o.receipt.amountBaseUnits), 0n);
    const completedInputs = new Set(prior.filter(e => e.kind === "paid_step_checkpoint").map(e => (e.data as { inputHash: string }).inputHash));
    for(const event of prior.filter(e=>e.kind==='payment_requested')){
      const payment=event.data as {requestId:string;quote:X402Quote};
      if(retained.has(payment.requestId))completedInputs.add(digest({toolId:payment.quote.toolId,input:payment.quote.input}));
    }
    const tools = this.executor.catalog().filter(t => run.agent.toolIds.includes(t.id));
    const compose = (reason: string, complete = false) => {
      const observed = specialistEvidenceReport(run, observations);
      if (observed) return observed;
      const evidence = observations.map(o => `- ${o.toolId}: receipt ${o.receipt.transaction} (${o.receipt.amountBaseUnits} base units on ${o.receipt.network})`).join("\n");
      if (complete) return reason;
      return `Investigation incomplete: ${reason}\n\n${observations.length ? `Collected evidence remains available in the run history.\n${evidence}` : "No paid evidence was collected."}`;
    };
    try {
      if (!tools.length) throw new AgentAuthorityError("None of this agent's selected tools is configured");
      let planIndex = 0;
      if (approvedPlan) {
        for (const step of approvedPlan.steps) {
          if (completedInputs.has(digest({ toolId: step.toolId, input: step.input }))) planIndex++;
          else break;
        }
        const remaining = approvedPlan.steps.slice(planIndex);
        if (remaining.length) {
          const failures = await probePlanSteps(this.executor, { steps: remaining, reasoning: approvedPlan.reasoning }, run.agent.perCallBaseUnits, signal);
          if (planHasBlockingProbeFailures(failures)) {
            this.store.event(id, "probe_gate_blocked", { failures });
            this.store.finish(id, observations.length ? "partial" : "failed", compose(`Preflight failed. No payment was made.\n${failures.map(f => `- ${f.toolId}: ${f.message}`).join("\n")}`), "probe_gate");
            return;
          }
        }
      }
      for (let step = prior.filter(e => e.kind === "action_selected").length; step < run.agent.maxSteps; step++) {
        signal.throwIfAborted();
        if (this.store.run(id)?.state !== "running") throw new Error("Run no longer permits new actions");
        const remaining = BigInt(run.agent.budgetBaseUnits) - spent;
        const planned = approvedPlan?.steps[planIndex];
        const response = planned ? { decision: { action: "tool" as const, ...planned }, usage: { provider: "approved-plan", billedThroughX402: false, totalTokenCount: 0 } } : await this.model.next({ run, tools, observations, failures, remainingBaseUnits: remaining.toString(), remainingSteps: run.agent.maxSteps - step }, signal);
        this.store.event(id, "model_usage", response.usage);
        signal.throwIfAborted();
        const decision = response.decision;
        if (decision.action === "finish") {
          if (typeof decision.result !== "string" || !decision.result.trim() || decision.result.length > 250000 || typeof decision.complete !== "boolean" || !Array.isArray(decision.evidenceIds) || decision.evidenceIds.some(e => !observations.some(o => o.requestId === e))) throw new Error("Model returned an invalid or unsupported result");
          const minimumTools = 1;
          const cited = observations.filter(o => !o.error && o.data !== null && decision.evidenceIds.includes(o.requestId));
          const complete = decision.complete && new Set(cited.map(o => o.toolId)).size >= minimumTools;
          const observedReport = specialistEvidenceReport(run, observations);
          this.store.event(id, "conclusion", { complete, evidenceIds: decision.evidenceIds, reportStrategy: observedReport ? "observed-fields" : "model-interpretation" });
          this.store.finish(id, complete ? "completed" : "partial", observedReport ?? decision.result,
            complete ? null : "The task did not establish completion with the required evidence.");
          return;
        }
        if (decision.action !== "tool" || !tools.some(t => t.id === decision.toolId) || !decision.input || typeof decision.input !== "object" || Array.isArray(decision.input) || typeof decision.reason !== "string" || !decision.reason.trim() || decision.reason.length > 2000) throw new AgentAuthorityError("Model requested an invalid or unpermitted action");
        this.store.event(id, "action_selected", { step: step + 1, ...decision });
        const inputHash = digest({ toolId: decision.toolId, input: decision.input });
        if (completedInputs.has(inputHash)) {
          failures.push({ toolId: decision.toolId, reason: "This exact tool input already produced paid evidence. Use the retained observation; do not buy it again." });
          this.store.event(id, "duplicate_action_blocked", { toolId: decision.toolId, inputHash });
          if (planned) planIndex++;
          continue;
        }
        let quote: X402Quote;
        try { quote = await this.executor.quote(decision.toolId, decision.input, signal); }
        catch (e) {
          if (signal.aborted) throw e;
          failures.push({ toolId: decision.toolId, reason: classifyProbeFailure(e).userMessage });
          this.store.event(id, "unpaid_tool_failure", failures.at(-1));
          if (planned) {
            this.store.finish(id, observations.length ? "partial" : "failed", compose(failures.at(-1)!.reason), "probe_gate");
            return;
          }
          continue;
        }
        if (quote.toolId !== decision.toolId || !positiveUnits(quote.amountBaseUnits)) throw new AgentAuthorityError("Invalid x402 quote");
        if (BigInt(quote.amountBaseUnits) > remaining || BigInt(quote.amountBaseUnits) > BigInt(run.agent.perCallBaseUnits)) {
          failures.push({ toolId: decision.toolId, reason: "Quoted price exceeds the remaining or per-call allowance. Choose a cheaper permitted action or finish with available evidence." });
          this.store.event(id, "price_blocked", { ...failures.at(-1), amountBaseUnits: quote.amountBaseUnits });
          if (planned) {
            this.store.finish(id, observations.length ? "partial" : "failed", compose(failures.at(-1)!.reason), "price_blocked");
            return;
          }
          continue;
        }
        signal.throwIfAborted();
        if (this.store.run(id)?.state !== "running") throw new AgentAuthorityError("Run was stopped before payment");
        const requestId = randomUUID();
        this.store.event(id, "payment_requested", { requestId, quote });
        // Any execute failure may have signed a payment. Stop unless the executor
        // explicitly proves it was an authority rejection before signing.
        let observation: ToolObservation;
        try { observation = await this.executor.execute({ run, quote, requestId, remainingBaseUnits: remaining.toString(), signal }); }
        catch (e) {
          if (e instanceof ConfirmedPaidToolFailure) observation = e.observation;
          else {
            if (e instanceof AgentAuthorityError) throw e;
            throw new UncertainAgentPayment(`Payment needs review before further spending: ${errorText(e)}`);
          }
        }
        if (observation.requestId !== requestId || observation.toolId !== quote.toolId || observation.receipt.network !== quote.network || observation.receipt.asset.toLowerCase() !== quote.asset.toLowerCase() || !positiveUnits(observation.receipt.amountBaseUnits) || BigInt(observation.receipt.amountBaseUnits) > BigInt(quote.amountBaseUnits) || !observation.receipt.transaction) throw new UncertainAgentPayment("Payment response did not match the reviewed quote");
        spent += BigInt(observation.receipt.amountBaseUnits);
        observations.push(observation);
        this.store.event(id, "tool_observation", observation);
        completedInputs.add(inputHash);
        if (planned) planIndex++;
        this.store.event(id, "paid_step_checkpoint", { nextStepIndex: step + 1, spentBaseUnits: spent.toString(), inputHash, requestId });
      }
      this.store.finish(id, "partial", compose("Step limit reached"));
    } catch (e) {
      if (e instanceof AgentModelError && e.usage) this.store.event(id, "model_usage", { ...e.usage, failed: true });
      const reason = errorText(e);
      this.store.event(id, e instanceof UncertainAgentPayment ? "payment_uncertain" : "execution_stopped", { reason });
      const state = this.store.run(id)?.state;
      if (state && !TERMINAL_AGENT_STATES.has(state)) this.store.finish(id,
        state === "stopping" ? "stopped" : observations.length ? "partial" : "failed", compose(reason), reason);
    } finally { clearTimeout(timer); this.active.delete(id); }
  }
}
