/** Canonical local mainnet agent workspace. No signing or payment at startup. */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { previewAgentPlan, type ReviewedPlan } from "./agent-plan.ts";
import { randomUUID } from "node:crypto";
import { Journal, digest } from "./journal.ts";
import { AgentStore } from "./agent-store.ts";
import { AgentRuntime, type ToolObservation } from "./agent-runtime.ts";
import { buildAgentReport, agentReportToMarkdown, type AgentPaymentView } from "./agent-report.ts";
import { loadAgentServices, type AgentServices } from "./agent-services.ts";
import { startLocalAgentTools, LOCAL_TOOL_ORIGIN } from "./agent-local-tools.ts";
import { readSetupDraft, saveSetupDraft, inspectSetup, prepareSetup } from "./workspace-setup.ts";
import { HttpError, OperatorAuth } from "./operator-auth.ts";
export interface OperatorOptions { root: string; dataDir?: string; port?: number; agentServices?: AgentServices }
export interface OperatorApp { server: Server; journal: Journal; dataDir: string; close: () => Promise<void> }
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new HttpError(415, "Use application/json");
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.from(chunk); size += b.length;
    if (size > 32768) throw new HttpError(413, "Operator request exceeds 32 KB");
    chunks.push(b);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, "Expected a JSON object"); }
}
function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);

export async function createOperatorApp(options: OperatorOptions): Promise<OperatorApp> {
  const root = resolve(options.root), dataDir = resolve(options.dataDir ?? join(root, "state/mainnet/operator"));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const journal = new Journal(join(dataDir, "workspace.sqlite"));
  const releaseOwner = journal.own("operator-workspace");
  const auth = new OperatorAuth(journal, dataDir);
  const agents = new AgentStore(journal.db);
  agents.interruptActive();
  journal.db.exec("CREATE TABLE IF NOT EXISTS agent_previews(id TEXT PRIMARY KEY, body TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  let loadedAgentServices = options.agentServices ? { services: options.agentServices, reason: "Ready" } : await loadAgentServices(dataDir, journal);
  let agentServices = loadedAgentServices.services;
  let agentRuntime = agentServices ? new AgentRuntime(agents, agentServices.model, agentServices.executor) : null;
  let localTools: { server: import("node:http").Server; origin: string } | null = null;
  const startToolsIfConfigured = async () => {
    if (localTools || !agentServices) return;
    const cfg = JSON.parse(await readFile(join(dataDir, "agent-runtime.json"), "utf8").catch(() => "null")) as { tools?: import("./agent-tools.ts").AgentToolConfiguration; funding?: { facilitatorUrl: string }; authority?: { spendingAddress: string } } | null;
    if (!cfg?.tools?.endpoints || !cfg.funding?.facilitatorUrl || !cfg.authority?.spendingAddress) return;
    if (!Object.values(cfg.tools.endpoints).some(url => url.startsWith(LOCAL_TOOL_ORIGIN))) return;
    localTools = await startLocalAgentTools({ payTo: cfg.authority.spendingAddress, facilitatorUrl: cfg.funding.facilitatorUrl, journal, tools: cfg.tools });
  };
  await startToolsIfConfigured().catch(error => { loadedAgentServices = { services: agentServices, reason: `First-party tools did not start: ${messageOf(error)}` }; });
  const activeAgentRuns = new Map<string, Promise<void>>();
  let setupError: string | null = null;
  let agentSetupTask: Promise<unknown> | null = null;
  const runAgentSetupTask = (action: () => Promise<unknown>) => {
    if (agentSetupTask) throw new HttpError(409, "An allowance operation is already in progress");
    setupError=null;
    const task = Promise.resolve().then(action).catch(e => {
      setupError=messageOf(e);
      if (agentServices) journal.event(agentServices.authorityId, null, "agent.setup_operation_failed", { error: messageOf(e) });
    }).finally(() => { if (agentSetupTask === task) agentSetupTask = null; });
    agentSetupTask = task;
  };
  const paymentsForAgentRun = (id: string): AgentPaymentView[] => {
    const rows = journal.db.prepare("SELECT r.* FROM requests r JOIN request_budget_groups g ON r.id=g.request_id WHERE g.group_id=? ORDER BY r.created_at").all(id) as unknown as Array<{id:string;state:string;network:string;asset:string;charged:string|null;maximum:string;receipt:string|null;error:string|null;created_at:number}>;
    return rows.map(r => { const receipt = r.receipt ? JSON.parse(r.receipt) as {transaction?:string;chainVerified?:boolean} : null; return {id:r.id,state:r.state,network:r.network,asset:r.asset,amountBaseUnits:r.charged??r.maximum,transaction:receipt?.transaction??null,chainVerified:receipt?.chainVerified===true,error:r.error,createdAt:r.created_at}; });
  };
  const server = createServer({ maxHeaderSize: 16384 }, async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
    const port = (server.address() as { port: number } | null)?.port ?? options.port ?? 8410;
    const origin = `http://127.0.0.1:${port}`;
    try {
      if (req.headers.host !== `127.0.0.1:${port}`) throw new HttpError(403, "Use the exact loopback operator address; unexpected Host blocked");
      const url = new URL(req.url ?? "/", origin), path = url.pathname;
      if (req.method === "GET" && path === "/healthz") { respond(res, 200, { ok: true, service: "mandate-operator", signingAtStartup: false }); return; }
      if (req.method === "GET") {
        const staticRoutes: Record<string, { name: string; contentType: string }> = {
          "/": { name: "workspace.html", contentType: "text/html; charset=utf-8" },
          "/workspace": { name: "workspace.html", contentType: "text/html; charset=utf-8" },
          "/workspace/": { name: "workspace.html", contentType: "text/html; charset=utf-8" },
          "/workspace.js": { name: "workspace.js", contentType: "text/javascript; charset=utf-8" },
          "/setup.js": { name: "setup.js", contentType: "text/javascript; charset=utf-8" },
          "/agents.js": { name: "agents.js", contentType: "text/javascript; charset=utf-8" },
          "/workspace.css": { name: "workspace.css", contentType: "text/css; charset=utf-8" },
          "/favicon.svg": { name: "favicon.svg", contentType: "image/svg+xml" },
        };
        const asset = staticRoutes[path];
        if (asset) {
          if (asset.contentType.startsWith("text/html")) auth.loginFromLocalNavigation(req, res, origin);
          const body = await readFile(join(root, "console", asset.name));
          res.writeHead(200, { "content-type": asset.contentType, "cache-control": "no-store" });
          res.end(body); return;
        }
      }
      if (!path.startsWith("/api/")) { respond(res, 404, { error: "This route is not part of the workspace" }); return; }
      if (path === "/api/session" && req.method === "POST") {
        const body = await jsonBody(req), principal = auth.login(req, res, String(body.token ?? ""), origin);
        respond(res, 200, { role: principal.role, csrf: principal.role === "operator" ? principal.csrf : null }); return;
      }
      const principal = auth.authenticate(req, origin);
      if (path === "/api/session" && req.method === "DELETE") { auth.logout(principal, res); respond(res, 200, { ok: true }); return; }
      if (!['/api/state', '/api/session', '/api/agents', '/api/setup-draft', '/api/setup-inspect', '/api/setup-prepare', '/api/setup-device'].includes(path) && !path.startsWith('/api/agents/') && !path.startsWith('/api/agent-')) {
        throw new HttpError(410, "This operator route was retired. Use the mainnet agent workspace.");
      }
      if (path === '/api/setup-draft' && req.method === 'GET') { auth.operator(principal); respond(res,200,{draft:await readSetupDraft(dataDir),configured:Boolean(agentServices)});return; }
      if (path === '/api/setup-draft' && req.method === 'PUT') { auth.operator(principal); respond(res,200,{draft:await saveSetupDraft(dataDir,await jsonBody(req))});return; }
      if (path === '/api/setup-inspect' && req.method === 'POST') { auth.operator(principal); await jsonBody(req); respond(res,200,await inspectSetup(await readSetupDraft(dataDir)));return; }
      if (path === '/api/setup-device' && req.method === 'POST') {
        auth.operator(principal);await jsonBody(req);if(agentSetupTask||activeAgentRuns.size)throw new HttpError(409,'Finish the current operation first');
        const {DmkEvmSigner}=await import('./dmksigner.ts');const signer=await DmkEvmSigner.create({checkOnDevice:true,timeoutMs:90000});
        const draft=await readSetupDraft(dataDir);await saveSetupDraft(dataDir,{...draft,payerAddress:signer.address});
        respond(res,200,{address:signer.address,signatureCreated:false});return;
      }
      if (path === '/api/setup-prepare' && req.method === 'POST') {
        auth.operator(principal);const body=await jsonBody(req);if(body.confirm!=='prepare_mainnet_wallet')throw new HttpError(400,'Confirm preparation of the mainnet spending wallet');
        if(agentSetupTask||activeAgentRuns.size||agentServices&&journal.mandate(agentServices.authorityId)?.state!=='closed')throw new HttpError(409,'Close and return the existing allowance before replacing its configuration');
        let prepared:unknown;
        runAgentSetupTask(async()=>{
          if(localTools){await new Promise<void>(resolve=>localTools!.server.close(()=>resolve()));localTools=null;}
          prepared=await prepareSetup(dataDir,await readSetupDraft(dataDir));
          loadedAgentServices=await loadAgentServices(dataDir,journal);
          agentServices=loadedAgentServices.services;
          agentRuntime=agentServices?new AgentRuntime(agents,agentServices.model,agentServices.executor):null;
          await startToolsIfConfigured();
        });
        await agentSetupTask;if(!prepared||!agentServices)throw new HttpError(400,setupError??loadedAgentServices.reason??'Preparation did not complete');respond(res,201,prepared);return;
      }
      if (path === "/api/agent-setup" && req.method === "GET") {
        auth.operator(principal); respond(res,200,{setup:agentServices?.inspect?.()??null,readiness:agentServices?.readiness?.()??{ready:false,reason:loadedAgentServices.reason},busy:Boolean(agentSetupTask)});return;
      }
      if (path === "/api/agent-setup/fund" && req.method === "POST") {
        auth.operator(principal);const body=await jsonBody(req);
        if(Object.keys(body).some(k=>!["consentHash","confirm"].includes(k))||body.confirm!=="fund_mainnet_agent_allowance"||typeof body.consentHash!=="string")throw new HttpError(400,"Review and explicitly approve the mainnet allowance first");
        const funding=agentServices?.funding;if(!funding)throw new HttpError(409,"Prepare the agent allowance before funding");
        if(activeAgentRuns.size)throw new HttpError(409,"Finish or stop the current investigation first");
        if(body.consentHash!==funding.review().consentHash||funding.review().funding.status!=="none")throw new HttpError(409,"Funding was already requested or its review changed. Observe or reconcile the existing attempt.");
        runAgentSetupTask(()=>funding.fund(body.consentHash as string));respond(res,202,{accepted:true,action:"ledger_mainnet_funding"});return;
      }
      if (path === "/api/agent-setup/reconcile" && req.method === "POST") {
        auth.operator(principal);const body=await jsonBody(req);if(Object.keys(body).some(k=>k!=="transactionHash"))throw new HttpError(400,"Only an optional existing funding transaction hash is accepted");
        const funding=agentServices?.funding;if(!funding)throw new HttpError(409,"No funding setup is configured");
        runAgentSetupTask(()=>funding.reconcile(body.transactionHash===undefined?undefined:String(body.transactionHash)));respond(res,202,{accepted:true,newPaymentRequested:false});return;
      }
      if (path === "/api/agent-setup/increase-preview" && req.method === "POST") {
        auth.operator(principal);const body=await jsonBody(req);
        if(Object.keys(body).some(k=>k!=="amountBaseUnits")||typeof body.amountBaseUnits!=="string"||!/^[1-9][0-9]{0,15}$/.test(body.amountBaseUnits))throw new HttpError(400,"Choose a positive USDC allowance increase");
        const funding=agentServices?.funding;if(!funding)throw new HttpError(409,"No Ledger funding setup is configured");
        if(activeAgentRuns.size||agentSetupTask)throw new HttpError(409,"Finish the current investigation or allowance operation before reviewing an increase");
        respond(res,200,{review:funding.reviewIncrease(body.amountBaseUnits)});return;
      }
      if (path === "/api/agent-setup/increase" && req.method === "POST") {
        auth.operator(principal);const body=await jsonBody(req);
        if(Object.keys(body).some(k=>!["amountBaseUnits","consentHash","confirm"].includes(k))||typeof body.amountBaseUnits!=="string"||!/^[1-9][0-9]{0,15}$/.test(body.amountBaseUnits)||typeof body.consentHash!=="string"||body.confirm!=="increase_mainnet_agent_allowance")throw new HttpError(400,"Review and explicitly approve the allowance increase first");
        const funding=agentServices?.funding;if(!funding)throw new HttpError(409,"No Ledger funding setup is configured");
        if(activeAgentRuns.size||agentSetupTask)throw new HttpError(409,"Finish the current investigation or allowance operation before increasing the allowance");
        const review=funding.reviewIncrease(body.amountBaseUnits);if(review.consentHash!==body.consentHash)throw new HttpError(409,"Allowance increase changed. Review it again before signing.");
        runAgentSetupTask(()=>funding.increase(body.amountBaseUnits as string,body.consentHash as string));respond(res,202,{accepted:true,action:"ledger_mainnet_allowance_increase"});return;
      }
      if (path === "/api/agent-setup/increase-reconcile" && req.method === "POST") {
        auth.operator(principal);const body=await jsonBody(req);if(Object.keys(body).some(k=>k!=="transactionHash"))throw new HttpError(400,"Only an optional existing allowance-increase transaction hash is accepted");
        const funding=agentServices?.funding;if(!funding)throw new HttpError(409,"No Ledger funding setup is configured");
        if(activeAgentRuns.size)throw new HttpError(409,"Finish the current investigation before reconciling an allowance increase");
        runAgentSetupTask(()=>funding.reconcileIncrease(body.transactionHash===undefined?undefined:String(body.transactionHash)));respond(res,202,{accepted:true,newSignatureCreated:false,newPaymentRequested:false});return;
      }
      if (path === "/api/agent-setup/stop" && req.method === "POST") {
        auth.operator(principal);const body=await jsonBody(req);if(body.confirm!=="stop_agent_allowance"||Object.keys(body).some(k=>k!=="confirm"))throw new HttpError(400,"Explicitly confirm stopping the allowance");
        if(!agentServices)throw new HttpError(409,"No agent allowance is configured");
        journal.stop(agentServices.authorityId);for(const id of activeAgentRuns.keys())agentRuntime?.stop(id);
        respond(res,200,{stopped:true,reversesPayments:false});return;
      }
      if (path === "/api/agent-setup/return-preview" && req.method === "GET") {
        auth.operator(principal);if(!agentServices?.returns)throw new HttpError(409,"The exact-wallet return path is not configured");
        if(activeAgentRuns.size||agentSetupTask)throw new HttpError(409,"Finish the current run or allowance operation before reviewing a return");
        respond(res,200,{review:await agentServices.returns.preview()});return;
      }
      if (path === "/api/agent-setup/return" && req.method === "POST") {
        auth.operator(principal);const body=await jsonBody(req);if(Object.keys(body).some(k=>!["consentHash","confirm"].includes(k))||typeof body.consentHash!=="string"||body.confirm!=="return_unused_usdc")throw new HttpError(400,"Review and explicitly confirm returning unused funds");
        const returns=agentServices?.returns;if(!returns)throw new HttpError(409,"The exact-wallet return path is not configured");
        if(activeAgentRuns.size||agentSetupTask)throw new HttpError(409,"Finish or stop the current investigation or allowance operation first");
        if((await returns.preview()).consentHash!==body.consentHash)throw new HttpError(409,"Return amount changed. Review the current balance again.");
        runAgentSetupTask(()=>returns.returnUnused(body.consentHash as string));respond(res,202,{accepted:true,action:"return_to_original_payer"});return;
      }
      if (path === "/api/agent-setup/return-reconcile" && req.method === "POST") {
        auth.operator(principal);const body=await jsonBody(req);if(Object.keys(body).some(k=>k!=="transactionHash"))throw new HttpError(400,"Only an optional existing return transaction hash is accepted");
        const returns=agentServices?.returns;if(!returns)throw new HttpError(409,"No return path is configured");
        runAgentSetupTask(()=>returns.reconcile(body.transactionHash===undefined?undefined:String(body.transactionHash)));respond(res,202,{accepted:true,newPaymentRequested:false});return;
      }
      if (path === "/api/agent-payments/reconcile" && req.method === "POST") {
        auth.operator(principal);const body=await jsonBody(req);if(Object.keys(body).some(k=>!["requestId","transaction"].includes(k))||typeof body.requestId!=="string"||body.transaction!==undefined&&(typeof body.transaction!=="string"||!/^(0x[0-9a-fA-F]{64}|0\.0\.[0-9]{1,15}[-@][0-9]{1,12}[-.][0-9]{1,9})$/.test(body.transaction)))throw new HttpError(400,"Choose one existing payment request");
        if(!agentServices?.reconcilePayment)throw new HttpError(409,"No first-party payment reconciliation is configured");
        if(activeAgentRuns.size)throw new HttpError(409,"Wait for the current investigation to stop before recovering its receipt");
        const result=await agentServices.reconcilePayment(body.requestId, body.transaction as string | undefined);
        const existing=agents.events(result.runId).some(e=>e.kind==="payment_reconciled"&&(e.data as {observation?:{requestId?:string}}).observation?.requestId===body.requestId);
        if(!existing)agents.event(result.runId,"payment_reconciled",{observation:result.observation,newSignatureCreated:false,newPaymentRequested:false});
        respond(res,200,{reconciled:true,runId:result.runId,observation:result.observation,newPaymentRequested:false});return;
      }
      if (path === "/api/agents" && req.method === "GET") {
        auth.operator(principal);
        const readiness = agentServices?.readiness?.() ?? { ready: Boolean(agentRuntime), reason: loadedAgentServices.reason };
        const availableTools = agentServices?.executor.catalog().map(t => t.id) ?? [];
        const availability = Object.fromEntries(agents.profiles().map(p => [
          p.id,
          {
            ready: readiness.ready && p.toolIds.some(id => availableTools.includes(id)),
            reason: !readiness.ready ? readiness.reason : !p.toolIds.some(id => availableTools.includes(id)) ? "None of this agent's selected tools is configured." : readiness.reason,
          },
        ]));
        respond(res, 200, { agents: agents.profiles(), runs: agents.runs(), ready: readiness.ready,
          availableTools, availability, readiness: readiness.reason, setup: agentServices?.inspect?.() ?? null, runningCount: activeAgentRuns.size, busy: Boolean(agentSetupTask) }); return;
      }
      if (path === "/api/agents" && req.method === "POST") {
        auth.operator(principal);
        respond(res, 201, { agent: agents.save(await jsonBody(req)) }); return;
      }
      const agentEdit = path.match(/^\/api\/agents\/([A-Za-z0-9_-]+)$/);
      if (agentEdit && req.method === "PUT") {
        auth.operator(principal);
        const { expectedVersion, ...body } = await jsonBody(req);
        respond(res, 200, { agent: agents.save(body, agentEdit[1]!, Number(expectedVersion)) }); return;
      }
      if (path === '/api/agent-preview' && req.method === 'POST') {
        auth.operator(principal);const body=await jsonBody(req);
        if(!agentServices||activeAgentRuns.size||agentSetupTask)throw new HttpError(409,'Finish setup or the current operation before planning');
        const goal=String(body.goal??'').trim();if(goal.length>8000)throw new HttpError(400,'Goal is too long');
        const agent=agents.profile(String(body.agentId??''));const now=Date.now();
        const run={id:randomUUID(),agent,goal,authorityId:agentServices.authorityId,intentHash:'preview',state:'queued' as const,createdAt:now,updatedAt:now,deadline:now+agent.maxDurationSeconds*1000,result:null,error:null};
        const plan=await previewAgentPlan(agentServices.model,agentServices.executor,run,AbortSignal.timeout(240000));
        journal.db.prepare('DELETE FROM agent_previews WHERE expires_at<?').run(Date.now());
        journal.db.prepare('INSERT INTO agent_previews VALUES(?,?,?)').run(plan.id,JSON.stringify(plan),plan.expiresAt);
        respond(res,200,{plan,paidRequests:0});return;
      }
      if (path === "/api/agent-runs" && req.method === "POST") {
        auth.operator(principal);
        const body = await jsonBody(req);
        if (Object.keys(body).some(k => !["requestId", "agentId", "goal", "planId"].includes(k))) throw new HttpError(400, "Run input cannot change payment authority");
        const existingRun = agents.run(String(body.requestId ?? ""));
        if (existingRun) {
          const run = agents.createRun({ id: existingRun.id, agentId: String(body.agentId ?? ""), goal: String(body.goal ?? ""), authorityId: existingRun.authorityId });
          respond(res, 200, { run }); return;
        }
        if (!agentRuntime || !agentServices) throw new HttpError(409, "Model and x402 spending authority are not ready");
        if (activeAgentRuns.size) throw new HttpError(409, "One investigation is already using this allowance. Finish or stop it before starting another.");
        const readiness = agentServices.readiness?.();
        if (readiness && !readiness.ready) throw new HttpError(409, readiness.reason);
        const profile = agents.profile(String(body.agentId ?? "")), available = agentServices.executor.catalog();
        if (!profile.toolIds.some(id => available.some(t => t.id === id))) throw new HttpError(409, "Required tools for this agent are not configured");
        let approved:ReviewedPlan|undefined;
        if(agentServices.model.plan||body.planId){
          const row=journal.db.prepare('SELECT body FROM agent_previews WHERE id=? AND expires_at>?').get(String(body.planId??''),Date.now()) as {body:string}|undefined;
          if(!row)throw new HttpError(409,'Preview the current plan and prices before starting');
          approved=JSON.parse(row.body) as ReviewedPlan;
          if(approved.intentHash!==digest({agent:profile,goal:String(body.goal??'').trim(),authorityId:agentServices.authorityId}))throw new HttpError(409,'Goal or agent changed. Preview the plan again.');
        }
        const run = agents.createRun({ id: String(body.requestId ?? ""), agentId: String(body.agentId ?? ""), goal: String(body.goal ?? ""), authorityId: agentServices.authorityId });
        if(approved){agents.event(run.id,'plan_approved',approved);agents.event(run.id,'model_usage',approved.modelUsage);journal.db.prepare('DELETE FROM agent_previews WHERE id=?').run(approved.id);}
        if (run.state === "queued" && !activeAgentRuns.has(run.id)) {
          const execution = agentRuntime.run(run.id).finally(() => activeAgentRuns.delete(run.id));
          activeAgentRuns.set(run.id, execution);
        }
        respond(res, 202, { run: agents.run(run.id) }); return;
      }
      const resumeRun = path.match(/^\/api\/agent-runs\/([A-Za-z0-9_-]+)\/resume$/);
      if (resumeRun && req.method === "POST") {
        auth.operator(principal); const body = await jsonBody(req);
        if (Object.keys(body).length) throw new HttpError(400, "Resume cannot change the original goal, profile or authority");
        if (!agentRuntime || !agentServices || activeAgentRuns.size || agentSetupTask) throw new HttpError(409, "Wait for the current operation to finish");
        const ready = agentServices.readiness?.(); if (ready && !ready.ready) throw new HttpError(409, ready.reason);
        const previous = agents.run(resumeRun[1]!);
        if (!previous || previous.authorityId !== agentServices.authorityId) throw new HttpError(409, "The original spending authority is required");
        const run = agents.resume(previous.id);
        const execution = agentRuntime.run(run.id).finally(() => activeAgentRuns.delete(run.id));
        activeAgentRuns.set(run.id, execution);
        respond(res, 202, { run: agents.run(run.id), restored: true }); return;
      }
      const followup=path.match(/^\/api\/agent-runs\/([A-Za-z0-9_-]+)\/followup$/);
      if(followup&&req.method==='POST'){
        auth.operator(principal);const body=await jsonBody(req),question=String(body.question??'').trim();
        if(!question||question.length>2000||Object.keys(body).some(k=>k!=='question'))throw new HttpError(400,'Ask one question of up to 2000 characters');
        const run=agents.run(followup[1]!);if(!run||!run.result||!['completed','partial','failed','interrupted','stopped'].includes(run.state))throw new HttpError(409,'Open a finished result before asking a follow-up');
        if(!agentServices)throw new HttpError(409,'Configure the model before asking about a report');
        const observations=agents.events(run.id).filter(e=>e.kind==='tool_observation').map(e=>e.data as ToolObservation);
        const answer=await agentServices.model.next({run:{...run,goal:`Answer this question using ONLY the saved evidence and report. Do not perform new work. Question: ${question}\nSaved report: ${run.result}`},tools:[],observations,failures:[],remainingBaseUnits:'0',remainingSteps:0},AbortSignal.timeout(240000));
        agents.event(run.id,'model_usage',answer.usage);if(answer.decision.action!=='finish')throw new HttpError(400,'No additional tools are available in report follow-up');
        agents.event(run.id,'report_followup',{question,answer:answer.decision.result});respond(res,200,{answer:answer.decision.result,paidRequests:0});return;
      }
      const agentReport = path.match(/^\/api\/agent-runs\/([A-Za-z0-9_-]+)\/report$/);
      if (agentReport && req.method === "GET") {
        auth.operator(principal);const run=agents.run(agentReport[1]!);if(!run)throw new HttpError(404,"Agent run not found");
        const report=buildAgentReport(run,agents.events(run.id),paymentsForAgentRun(run.id));
        res.writeHead(200,{"content-type":"text/markdown; charset=utf-8","content-disposition":`attachment; filename="mandate-${run.id}.md"`,"cache-control":"no-store","x-content-type-options":"nosniff"});res.end(agentReportToMarkdown(report));return;
      }
      const agentRun = path.match(/^\/api\/agent-runs\/([A-Za-z0-9_-]+)(\/stop)?$/);
      if (agentRun) {
        auth.operator(principal);
        const run = agents.run(agentRun[1]!);
        if (!run) throw new HttpError(404, "Agent run not found");
        if (req.method === "POST" && agentRun[2]) {
          await jsonBody(req);
          if (agentRuntime) agentRuntime.stop(run.id); else agents.stop(run.id);
          respond(res, 200, { run: agents.run(run.id) }); return;
        }
        if (req.method === "GET" && !agentRun[2]) { respond(res, 200, { run, events: agents.events(run.id), report: buildAgentReport(run, agents.events(run.id), paymentsForAgentRun(run.id)) }); return; }
      }
      if (path === "/api/state" && req.method === "GET") {
        auth.operator(principal);
        respond(res, 200, { csrf: principal.role === "operator" ? principal.csrf : null, observedAt: Date.now(), network: "eip155:8453" }); return;
      }
      throw new HttpError(404, "Unknown workspace route");
    } catch (e) {
      if (!res.headersSent) respond(res, e instanceof HttpError ? e.status : 400, { error: messageOf(e) });
      else res.end();
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return { server, journal, dataDir, close: async () => {
    for (const id of activeAgentRuns.keys()) agentRuntime?.stop(id);
    await new Promise<void>(done => server.close(() => done()));
    await Promise.allSettled(activeAgentRuns.values());
    if (agentSetupTask) await agentSetupTask;
    if (localTools) await new Promise<void>(done => localTools!.server.close(() => done()));
    releaseOwner(); journal.close();
  } };
}
