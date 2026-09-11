/** Authenticated, loopback-only operator workspace. Startup performs no signing or payments. */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, mkdir, rename, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import { createPublicClient, http, erc20Abi } from "viem";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { Journal, digest } from "./journal.ts";
import { parseMandateFile, scopeOf, type MandateFile } from "./mandate-config.ts";
import { openMandate, resumeMandate, type Mandate } from "./mandate.ts";
import { assertPaymentScope } from "./scope.ts";
import { validateAnalyticsQuery } from "./query-scope.ts";
import { AGENT0_SAMPLE_QUERY } from "./analytics.ts";
import { HttpError, OperatorAuth, type Principal } from "./operator-auth.ts";

export const COMPARISON_QUERY = `{ agents(first: 5, orderBy: totalFeedback, orderDirection: desc) { id agentId agentWallet totalFeedback feedback(first: 5, orderBy: createdAt, orderDirection: desc) { value isRevoked } } _meta { block { number } } }`;
interface TaskRow {
  id: string; kind: string; mandate_id: string; capability_id: string | null; query: string;
  state: string; result: string | null; error: string | null; created_at: number; updated_at: number;
}
export interface OperatorOptions { root: string; dataDir?: string; port?: number }
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
  const root = resolve(options.root), dataDir = resolve(options.dataDir ?? join(root, "state/live/operator"));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const configPath = join(dataDir, "active-mandate.yaml");
  const journal = new Journal(join(dataDir, "workspace.sqlite"));
  const releaseOwner = journal.own("operator-workspace");
  const auth = new OperatorAuth(journal, dataDir);
  journal.db.exec(`CREATE TABLE IF NOT EXISTS workspace_tasks (
    id TEXT PRIMARY KEY,kind TEXT NOT NULL,mandate_id TEXT NOT NULL,capability_id TEXT,
    query TEXT NOT NULL,state TEXT NOT NULL,result TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);`);
  journal.db.prepare("UPDATE workspace_tasks SET state='interrupted',error='Broker restarted; reconcile this request before retrying',updated_at=? WHERE state IN ('queued','running','awaiting_device','awaiting_signature')").run(Date.now());
  let mandate: Mandate | undefined;
  let serial: Promise<unknown> = Promise.resolve();
  let shuttingDown = false;
  const tasks = () => journal.db.prepare("SELECT * FROM workspace_tasks ORDER BY created_at DESC LIMIT 100").all() as unknown as TaskRow[];
  const taskById = (id: string) => journal.db.prepare("SELECT * FROM workspace_tasks WHERE id=?").get(id) as unknown as TaskRow | undefined;
  const updateTask = (id: string, state: string, result?: unknown, error?: string) => {
    journal.db.prepare("UPDATE workspace_tasks SET state=?,result=?,error=?,updated_at=? WHERE id=?")
      .run(state, result === undefined ? null : JSON.stringify(result), error ?? null, Date.now(), id);
  };
  async function config(): Promise<MandateFile> {
    try { return parseMandateFile(await readFile(configPath, "utf8")); }
    catch (e) { throw new HttpError(409, `A reviewed v2 mandate is required: ${messageOf(e)}`); }
  }
  const configId = (cfg: MandateFile) => digest({ network: cfg.network, salt: cfg.salt });
  async function readFinancial(cfg: MandateFile): Promise<Record<string, unknown>> {
    const path = join(resolve(root, cfg.storageRoot), "broker.sqlite");
    if (!existsSync(path)) return { state: "not_funded", deposit: "none", spent: "0", reserved: "0", window: "0", channelId: null, events: [] };
    const j = mandate?.id === configId(cfg) ? mandate.journal : new Journal(path);
    try {
      const row = j.mandate(configId(cfg));
      const totals = j.totals(configId(cfg), cfg.windowMs);
      return { state: row?.state ?? "not_funded", deposit: row?.deposit ?? "none", ...totals,
        refundedBaseUnits: (() => { const event=j.events(configId(cfg)).find(e=>e.kind==="refund.transaction_confirmed"); return event ? JSON.parse(event.data).returnedBaseUnits ?? "0" : "0"; })(),
        channelId: row?.channel_id ?? null, payer: row?.payer ?? null, session: row?.session ?? null,
        requests: j.requests(configId(cfg)), events: j.events(configId(cfg)), eventChainValid: j.verifyEventChain(), pendingAnchors: j.pendingCount() };
    } finally { if (j !== mandate?.journal) j.close(); }
  }
  function merchantJournalPath(): string | null {
    const configured=process.env.MANDATE_LOCAL_MERCHANT_STATE;
    if (!configured || !process.env.MANDATE_LOCAL_MERCHANT_URL) return null;
    const path=join(resolve(root,configured),"merchant.sqlite");
    return existsSync(path) ? path : null;
  }
  function readMerchantEvidence(): {events: unknown[];eventChainValid: boolean;pendingAnchors: number} {
    const path=merchantJournalPath();
    if (!path) return {events:[],eventChainValid:true,pendingAnchors:0};
    const j=new Journal(path);
    try { return {events:j.events(),eventChainValid:j.verifyEventChain(),pendingAnchors:j.pendingCount()}; }
    finally { j.close(); }
  }
  async function reconcileExistingRefund(cfg:MandateFile, explicitTransaction?:string):Promise<unknown> {
    const finance=await readFinancial(cfg), mandateId=configId(cfg);
    if(!finance.channelId)throw new HttpError(409,"There is no channel to reconcile");
    const j=mandate?.journal ?? new Journal(join(resolve(root,cfg.storageRoot),"broker.sqlite"));
    try {
      const existing=j.events(mandateId).find(e=>e.kind==="refund.transaction_confirmed");
      if(j.mandate(mandateId)?.state==="refunded" && existing)return {success:true,newTransaction:false,...JSON.parse(existing.data)};
      const submitted=j.events(mandateId).find(e=>e.kind==="refund.transaction_submitted");
      const candidates:string[]=[];
      if(explicitTransaction)candidates.push(explicitTransaction);
      else if(submitted)candidates.push(JSON.parse(submitted.data).transaction);
      else {
        const merchant=process.env.MANDATE_LOCAL_MERCHANT_URL,tokenFile=process.env.MANDATE_MERCHANT_ADMIN_TOKEN_FILE;
        if(!merchant || !tokenFile || new URL(cfg.serviceUrl).origin!==merchant)throw new HttpError(409,"Provide the original refund transaction hash; no new refund will be sent");
        const response=await fetch(`${merchant}/admin/refund-receipts`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${(await readFile(tokenFile,"utf8")).trim()}`},body:JSON.stringify({channelId:finance.channelId}),redirect:"error",signal:AbortSignal.timeout(12000)});
        const body=await response.json() as {network?:string;candidates?:Array<{transaction:string}>};
        if(!response.ok || body.network!==cfg.network)throw new HttpError(409,"Cannot recover a receipt from the configured merchant");
        candidates.push(...(body.candidates??[]).map(c=>c.transaction));
      }
      const {confirmRefundTransaction}=await import("./reconciliation.ts");
      let last="No prior refund transaction is available";
      for(const hash of [...new Set(candidates)]) {
        try {
          if(!/^0x[0-9a-fA-F]{64}$/.test(hash))throw new Error("Invalid refund hash");
          const proof=await confirmRefundTransaction({rpcUrl:cfg.rpcUrl,chainId:84532,channelId:String(finance.channelId) as `0x${string}`,asset:cfg.asset,payer:cfg.operatorAddress,receiver:cfg.receiver,transaction:hash as `0x${string}`,expectedBaseUnits:String(BigInt(cfg.ceilingBaseUnits)-BigInt(String(finance.spent))),liabilityBaseUnits:String(finance.spent)});
          j.refundConfirmed(mandateId,proof);
          journal.event(mandateId,null,"refund.reconciled",{transaction:hash,newTransaction:false});
          for(const prior of tasks().filter(t=>t.mandate_id===mandateId&&t.kind==="refund"&&["uncertain","interrupted"].includes(t.state)))updateTask(prior.id,"reconciled",{...proof,originalError:prior.error,newTransaction:false});
          return {success:true,newTransaction:false,...proof};
        }catch(error){last=messageOf(error);}
      }
      throw new HttpError(409,`The original refund remains unresolved: ${last}`);
    }finally{if(j!==mandate?.journal)j.close();}
  }
  async function reconcilePriorLifecycleTasks(cfg:MandateFile):Promise<void> {
    const mandateId=configId(cfg), finance=await readFinancial(cfg);
    const current=tasks().filter(task=>task.mandate_id===mandateId);
    const successful=current.find(task=>task.kind==="settlement" && task.state==="succeeded" && task.result);
    const uncertain=current.filter(task=>task.kind==="settlement" && task.state==="uncertain");
    if(successful?.result && uncertain.length && finance.channelId) {
      const proof=JSON.parse(successful.result);
      if(proof.after?.channelId!==finance.channelId || !proof.settle?.transaction)throw new Error("Stored merchant resolution does not identify this channel");
      const {snapshotChannel,assertRefundTransfers}=await import("./reconciliation.ts");
      const snapshot=await snapshotChannel({rpcUrl:cfg.rpcUrl,chainId:84532,channelId:String(finance.channelId) as `0x${string}`,asset:cfg.asset,payer:cfg.operatorAddress,receiver:cfg.receiver});
      const receipt=await createPublicClient({transport:http(cfg.rpcUrl,{timeout:15000})}).getTransactionReceipt({hash:proof.settle.transaction});
      assertRefundTransfers(receipt,{asset:cfg.asset,payer:cfg.receiver,expectedBaseUnits:proof.receiverIncreaseBaseUnits});
      if(snapshot.claimedBaseUnits!==String(finance.spent) || snapshot.receiverAggregateClaimedBaseUnits!==snapshot.receiverAggregateSettledBaseUnits)throw new Error("Merchant revenue is not fully reconciled");
      for(const prior of uncertain)updateTask(prior.id,"reconciled",{originalError:prior.error,resolvedBy:successful.id,transaction:receipt.transactionHash,newTransaction:false,snapshot});
    }
    if(journal.pendingCount()===0 && Number(finance.pendingAnchors??0)===0) {
      const publication=current.find(task=>task.kind==="evidence" && task.state==="succeeded");
      if(publication)for(const prior of current.filter(task=>task.kind==="evidence" && task.state==="failed"))updateTask(prior.id,"reconciled",{originalError:prior.error,originalResult:prior.result?JSON.parse(prior.result):null,resolvedBy:publication.id,unanchoredEvents:0});
    }
  }
  async function legacyInfo(): Promise<Record<string, unknown> | null> {
    try {
      const v = parse(await readFile(join(root, "mandate.yaml"), "utf8")) as Record<string, unknown>;
      if (v?.version !== 1) return null;
      return { version: 1, message: "Original v1 configuration is preserved. Its channel and funds are not silently imported or reset. New authority uses a fresh salt and separate storage.",
        serviceUrl: v.serviceUrl, rpcUrl: v.rpcUrl, receiver: v.receiver, ceilingBaseUnits: v.ceilingBaseUnits };
    } catch { return null; }
  }
  async function ensureKeyRing(): Promise<void> {
    const loaderUrl = pathToFileURL(join(root, "scripts/load-wallet-pass.mjs")).href;
    const loader = await import(loaderUrl) as { ensureWalletPass: () => Promise<string> };
    if (!(await loader.ensureWalletPass())) throw new Error("Ledger Key Ring password is not available from the OS keychain. Provision it yourself; do not paste it into the app.");
  }
  async function acquireMandate(cfg: MandateFile, authorizeFunding: boolean, taskId?: string): Promise<Mandate> {
    if (mandate) {
      if (mandate.id !== configId(cfg)) throw new Error("Another mandate is loaded; stop it before changing scope");
      return mandate;
    }
    const existing = await readFinancial(cfg);
    if (!authorizeFunding && !(existing.channelId && existing.deposit === "funded")) {
      throw new Error("An operator must authorize initial funding on Ledger; an agent cannot initialize or top up a mandate");
    }
    await ensureKeyRing();
    const params = { scope: scopeOf(cfg), expectedPayer: cfg.operatorAddress, rpcUrl: cfg.rpcUrl,
      storageRoot: resolve(root, cfg.storageRoot), sessionKeyName: cfg.sessionKey,
      sealedSessionKey: await readFile(join(root, "secrets", `${cfg.sessionKey}.enc`)),
      ceilingBaseUnits: cfg.ceilingBaseUnits, salt: cfg.salt, derivationPath: cfg.derivationPath, deviceTimeoutMs: Math.min(Number(process.env.MANDATE_DEVICE_TIMEOUT_MS ?? 120000), 900000),
      onDeviceState: (state: "awaiting_signature" | "signature_verified") => { if (taskId) updateTask(taskId, state === "awaiting_signature" ? "awaiting_signature" : "running"); } };
    if (existing.channelId && existing.deposit === "funded") mandate = await resumeMandate(params);
    else {
      if (!authorizeFunding) throw new Error("An operator must authorize initial funding on Ledger; an agent cannot initialize or top up a mandate");
      mandate = await openMandate(params);
    }
    return mandate;
  }
  function enqueueTask(cfg: MandateFile, query: string, principal: Principal, authorizeFunding: boolean, id: string): TaskRow {
    validateAnalyticsQuery(query);
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new HttpError(400, "Invalid task idempotency key");
    const mandateId = configId(cfg);
    if (principal.role === "agent" && (principal.mandateId !== mandateId || principal.queryHash !== digest(query))) throw new HttpError(403, "This task is outside the agent's scoped capability");
    if (principal.role === "agent" && authorizeFunding) throw new HttpError(403, "Agents cannot request Ledger funding");
    const prior = taskById(id);
    if (prior) {
      if (prior.query !== query || prior.mandate_id !== mandateId || prior.capability_id !== (principal.role === "agent" ? principal.capabilityId : null)) throw new HttpError(409, "Idempotency key is bound to another task");
      return prior;
    }
    if (tasks().filter(t => ["queued","running","awaiting_device","awaiting_signature"].includes(t.state)).length >= 10) throw new HttpError(429, "Task queue is full");
    journal.db.prepare("INSERT INTO workspace_tasks(id,kind,mandate_id,capability_id,query,state,created_at,updated_at) VALUES(?,'query',?,?,?,'queued',?,?)")
      .run(id, mandateId, principal.role === "agent" ? principal.capabilityId : null, query, Date.now(), Date.now());
    journal.event(mandateId, id, "task.queued", { query, actor: principal.role, authorizeFunding });
    const run = async () => {
      try {
        if (shuttingDown) throw new Error("Broker is shutting down");
        if (principal.role === "agent" && principal.expiresAt <= Date.now()) throw new Error("Agent capability expired while queued");
        if (principal.role === "agent") {
          const cap = journal.db.prepare("SELECT revoked FROM agent_capabilities WHERE id=?").get(principal.capabilityId);
          if (!cap || cap.revoked) throw new Error("Agent capability was revoked");
        }
        updateTask(id, authorizeFunding ? "awaiting_device" : "running");
        const m = await acquireMandate(cfg, authorizeFunding, id);
        updateTask(id, "running");
        const url = new URL(cfg.serviceUrl); url.searchParams.set("q", query);
        const response = await m.fetch(url, { headers: { "idempotency-key": id } });
        const text = await response.text();
        let body: unknown;
        try { body = JSON.parse(text); } catch { body = { body: text }; }
        if (!response.ok) throw new Error(`Paid service returned HTTP ${response.status}: ${text.slice(0, 500)}`);
        updateTask(id, "succeeded", { data: body, requestId: id, status: response.status,
          paymentResponse: response.headers.get("payment-response"), completedAt: new Date().toISOString() });
        journal.event(mandateId, id, "task.succeeded", { responseHash: digest(body) });
      } catch (e) {
        const request = mandate?.journal.request(id);
        const state = request && ["signed","uncertain"].includes(request.state) ? "uncertain" : /budget exhausted|limit exceeded|outside the mandate|expired|new spending is blocked|closed/i.test(messageOf(e)) ? "blocked" : "failed";
        updateTask(id, state, undefined, messageOf(e));
        journal.event(mandateId, id, `task.${state}`, { message: messageOf(e) });
      }
    };
    serial = serial.then(run, run);
    return taskById(id)!;
  }
  async function preflight(input: Record<string, unknown>): Promise<unknown> {
    const cfg = await config().catch(() => null);
    const rpcUrl = String(input.rpcUrl ?? cfg?.rpcUrl ?? "https://sepolia.base.org");
    const serviceUrl = String(input.serviceUrl ?? cfg?.serviceUrl ?? "http://127.0.0.1:8405/analytics");
    for (const raw of [rpcUrl, serviceUrl]) {
      const u = new URL(raw);
      if (u.username || u.password || !(u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1","localhost","[::1]"].includes(u.hostname)))) throw new HttpError(400, "Probe targets must use HTTPS or loopback HTTP");
    }
    const result: Record<string, unknown> = { observedAt: new Date().toISOString(), signingAttempted: false, paid: false };
    const rpc = createPublicClient({ transport: http(rpcUrl, { timeout: 10000, retryCount: 0 }) });
    try {
      const chain = await rpc.getChainId();
      result.chain = { chainId: chain, expected: 84532, ok: chain === 84532 };
      if (chain === 84532 && cfg) {
        const [symbol, decimals, payerBalance, receiverBalance] = await Promise.all([
          rpc.readContract({ address: cfg.asset, abi: erc20Abi, functionName: "symbol" }),
          rpc.readContract({ address: cfg.asset, abi: erc20Abi, functionName: "decimals" }),
          rpc.readContract({ address: cfg.asset, abi: erc20Abi, functionName: "balanceOf", args: [cfg.operatorAddress] }),
          rpc.readContract({ address: cfg.asset, abi: erc20Abi, functionName: "balanceOf", args: [cfg.receiver] }),
        ]);
        result.token = { symbol, decimals, payerBalance: String(payerBalance), receiverBalance: String(receiverBalance) };
      }
    } catch (e) { result.chain = { ok: false, error: messageOf(e) }; }
    try {
      const response = await fetch(serviceUrl, { redirect: "error", signal: AbortSignal.timeout(10000) });
      if (response.status !== 402) throw new Error(`Expected an unsigned 402 offer, got HTTP ${response.status}`);
      const offer = decodePaymentRequiredHeader(response.headers.get("payment-required") ?? "");
      const payment = offer.accepts.find(p => p.scheme === "batch-settlement" && p.network === "eip155:84532");
      if (!payment) throw new Error("Service does not offer Base Sepolia batch settlement");
      result.service = { ok: true, status: response.status, requirements: payment };
      if (cfg) { assertPaymentScope(scopeOf(cfg), payment); result.scopeMatches = true; }
    } catch (e) { result.service = { ok: false, error: messageOf(e) }; }
    result.sealedSessionPresent = await access(join(root, "secrets", `${cfg?.sessionKey ?? "mandate-session"}.enc`)).then(() => true, () => false);
    journal.event(cfg ? configId(cfg) : "setup", null, "operator.preflight", result);
    return result;
  }
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
      if (req.method === "GET" && ["/", "/workspace.js", "/workspace.css", "/favicon.svg"].includes(path)) {
        const name = path === "/" ? "index.html" : path.slice(1);
        const body = await readFile(join(root, "console", name));
        res.writeHead(200, { "content-type": name.endsWith(".js") ? "text/javascript; charset=utf-8" : name.endsWith(".css") ? "text/css; charset=utf-8" : name.endsWith(".svg") ? "image/svg+xml" : "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(body); return;
      }
      if (!path.startsWith("/api/")) { respond(res, 404, { error: "This static prototype route is not part of the live workspace" }); return; }
      if (path === "/api/session" && req.method === "POST") {
        const body = await jsonBody(req), principal = auth.login(req, res, String(body.token ?? ""), origin);
        respond(res, 200, { role: principal.role, csrf: principal.role === "operator" ? principal.csrf : null }); return;
      }
      const principal = auth.authenticate(req, origin);
      if (path === "/api/session" && req.method === "DELETE") { auth.logout(principal, res); respond(res, 200, { ok: true }); return; }
      if (path === "/api/state" && req.method === "GET") {
        auth.operator(principal);
        const cfg = await config().catch(() => null);
        const merchantEvidence=readMerchantEvidence();
        respond(res, 200, { version: 2, observedAt: new Date().toISOString(), config: cfg,
          financial: cfg ? await readFinancial(cfg) : null, tasks: tasks(), legacy: await legacyInfo(), merchantEvidence,
          comparisonQuery: COMPARISON_QUERY, events: journal.events(), eventChainValid: journal.verifyEventChain(),
          csrf: principal.role === "operator" ? principal.csrf : null,
          boundary: "Ledger signs funding; the broker enforces resource, expiry and rolling limits. Voucher acceptance is not merchant revenue.",
          merchantLifecycleAvailable: Boolean(process.env.MANDATE_LOCAL_MERCHANT_URL && process.env.MANDATE_MERCHANT_ADMIN_TOKEN_FILE),
          configPath: relative(root, configPath), hcsConfigured: Boolean(process.env.MANDATE_HCS_TOPIC_ID && process.env.MANDATE_HEDERA_ACCOUNT_ID) }); return;
      }
      if (path === "/api/config" && req.method === "POST") {
        auth.operator(principal);
        const body = await jsonBody(req);
        if (body.network !== undefined && body.network !== "eip155:84532") throw new HttpError(400,"This workspace is Base Sepolia testnet-only");
        if (tasks().some(t => ["running","awaiting_device","awaiting_signature","queued"].includes(t.state))) throw new HttpError(409, "Finish or stop current work before changing authority");
        const previous = await config().catch(() => null);
        if (previous) {
          const f = await readFinancial(previous);
          if (f.deposit !== "none" && f.state !== "refunded") throw new HttpError(409, "Recover the previous mandate before replacing its configuration");
        }
        const salt = `0x${randomBytes(32).toString("hex")}`;
        const storageRoot = relative(root, join(dataDir, "mandates", salt.slice(2)));
        const cfg = parseMandateFile(stringify({ ...body, version: 2, network: "eip155:84532", salt, storageRoot }));
        if (Date.parse(cfg.expiresAt) <= Date.now()) throw new HttpError(400, "New authority must expire in the future");
        if (mandate) { mandate.close(); mandate = undefined; }
        await writeFile(`${configPath}.tmp`, stringify(cfg), { mode: 0o600 }); await rename(`${configPath}.tmp`, configPath);
        journal.event(configId(cfg), null, "operator.scope_saved", { scope: scopeOf(cfg), operator: cfg.operatorAddress, fundingAuthorized: false });
        respond(res, 201, { config: cfg, state: "configured_not_funded" }); return;
      }
      if (path === "/api/preflight" && req.method === "POST") { auth.operator(principal); respond(res, 200, await preflight(await jsonBody(req))); return; }
      if (path === "/api/device" && req.method === "POST") {
        auth.operator(principal); await jsonBody(req);
        const { DmkEvmSigner } = await import("./dmksigner.ts");
        const device = await DmkEvmSigner.create({ timeoutMs: 12000 });
        respond(res, 200, { address: device.address, signatureRequested: false, addressConfirmedOnDevice: false }); return;
      }
      if (path === "/api/tasks" && req.method === "POST") {
        const cfg = await config(), body = await jsonBody(req);
        const query = typeof body.query === "string" ? body.query : COMPARISON_QUERY;
        if (Object.keys(body).some(k => !["query","authorizeFunding","requestId"].includes(k))) throw new HttpError(400, "Task fields cannot override receiver, URL, asset or limits");
        const row = enqueueTask(cfg, query, principal, body.authorizeFunding === true, typeof body.requestId === "string" ? body.requestId : randomUUID());
        respond(res, 202, { task: row }); return;
      }
      if (path.startsWith("/api/tasks/") && req.method === "GET") {
        const task = taskById(path.slice("/api/tasks/".length));
        if (!task || (principal.role === "agent" && task.capability_id !== principal.capabilityId)) throw new HttpError(404, "Task not found");
        respond(res, 200, { task }); return;
      }
      if (path === "/api/stop" && req.method === "POST") {
        auth.operator(principal); await jsonBody(req);
        const cfg = await config(), id = configId(cfg);
        auth.revokeCapabilities(id);
        if (mandate) mandate.stop();
        else {
          const j = new Journal(join(resolve(root, cfg.storageRoot), "broker.sqlite"));
          try { j.register(id, { scope: scopeOf(cfg), salt: cfg.salt }); j.stop(id); } finally { j.close(); }
        }
        journal.event(id, null, "operator.stopped", { newRequestsBlocked: true, pastPaymentsReversed: false });
        respond(res, 200, { stopped: true, paidRequestsReversed: false }); return;
      }
      if (path === "/api/reconcile" && req.method === "POST") {
        auth.operator(principal); const body = await jsonBody(req), cfg = await config();
        await reconcilePriorLifecycleTasks(cfg);
        const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
        if(typeof body.refundTransaction==="string" || (!requestId && tasks().some(t=>t.mandate_id===configId(cfg)&&t.kind==="refund"&&["uncertain","interrupted"].includes(t.state)))) {
          respond(res,200,await reconcileExistingRefund(cfg,typeof body.refundTransaction==="string"?body.refundTransaction:undefined));return;
        }
        if (tasks().some(t => ["queued","running","awaiting_device","awaiting_signature"].includes(t.state))) throw new HttpError(409,"Wait for the current operation before reconciling");
        if (!mandate) {
          const finance = await readFinancial(cfg);
          if (finance.deposit !== "funded") {
            const {snapshotChannel} = await import("./reconciliation.ts");
            if (!finance.channelId || !finance.payer) throw new HttpError(409,"No attempted channel to reconcile");
            const snapshot = await snapshotChannel({rpcUrl:cfg.rpcUrl,chainId:84532,channelId:String(finance.channelId) as `0x${string}`,asset:cfg.asset,payer:cfg.operatorAddress,receiver:cfg.receiver});
            const j = new Journal(join(resolve(root,cfg.storageRoot),"broker.sqlite"));
            try {
              if (snapshot.balanceBaseUnits === "0") j.resetUnsignedDeposit(configId(cfg));
              else {
                const {assertFundingSnapshot} = await import("./reconciliation.ts");
                assertFundingSnapshot(snapshot,cfg.ceilingBaseUnits);j.funded(configId(cfg),snapshot);
              }
            } finally {j.close();}
            respond(res,200,{snapshot,newPayment:false,reviewBeforeRetry:true});return;
          }
        }
        const m = await acquireMandate(cfg,false);
        const result = await m.reconcile(requestId);
        if (requestId) {
          const row = m.journal.request(requestId);
          if (row?.state === "accepted" && row.response) {
            const response = JSON.parse(row.response);
            if (taskById(requestId)) updateTask(requestId,"succeeded",{data:JSON.parse(response.body),requestId,status:response.status,paymentResponse:response.headers["payment-response"],reconciledAt:new Date().toISOString()});
          }
        }
        respond(res,200,result);return;
      }
      if (path === "/api/release" && req.method === "POST") {
        auth.operator(principal); await jsonBody(req);
        if (tasks().some(t => ["queued","running","awaiting_device","awaiting_signature"].includes(t.state))) throw new HttpError(409, "Wait for running work before releasing the client");
        if (mandate) { mandate.close(); mandate = undefined; await new Promise(resolve => setImmediate(resolve)); }
        respond(res, 200, {released:true, revoked:false, newFundingAuthorized:false}); return;
      }
      if (path === "/api/settle" && req.method === "POST") {
        auth.operator(principal); const body = await jsonBody(req);
        if (body.confirm !== "claim_and_settle_testnet") throw new HttpError(400, "Explicit testnet settlement confirmation required");
        const cfg = await config(), finance = await readFinancial(cfg);
        const merchant = process.env.MANDATE_LOCAL_MERCHANT_URL;
        const tokenFile = process.env.MANDATE_MERCHANT_ADMIN_TOKEN_FILE;
        if (!merchant || !tokenFile || new URL(cfg.serviceUrl).origin !== merchant || !finance.channelId) throw new HttpError(409, "No configured local merchant lifecycle for this channel");
        const id = randomUUID();
        journal.db.prepare("INSERT INTO workspace_tasks(id,kind,mandate_id,query,state,created_at,updated_at) VALUES(?,'settlement',?,'','queued',?,?)").run(id,configId(cfg),Date.now(),Date.now());
        const run = async () => {
          try {
            updateTask(id,"running");
            const { snapshotChannel } = await import("./reconciliation.ts");
            const options = {rpcUrl:cfg.rpcUrl,chainId:84532,channelId:String(finance.channelId) as `0x${string}`,asset:cfg.asset,payer:cfg.operatorAddress,receiver:cfg.receiver};
            const before = await snapshotChannel(options);
            const response = await fetch(`${merchant}/admin/claim-settle`, {method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${(await readFile(tokenFile,"utf8")).trim()}`},body:JSON.stringify({channelId:finance.channelId}),signal:AbortSignal.timeout(120000),redirect:"error"});
            const result = await response.json() as {error?:string;network?:string;claims?:unknown[];settle?:{transaction:string}};
            if (!response.ok || result.network !== cfg.network) throw new Error(result.error ?? "Settlement failed or network mismatch");
            const transaction = result.settle?.transaction;
            const receipt = transaction ? await createPublicClient({transport:http(cfg.rpcUrl)}).waitForTransactionReceipt({hash:transaction as `0x${string}`,timeout:60000}) : undefined;
            if(receipt && receipt.status!=="success") throw new Error("Merchant sweep receipt reverted");
            const after = await snapshotChannel({...options,blockNumber:receipt?.blockNumber});
            if (BigInt(after.claimedBaseUnits) !== BigInt(String(finance.spent))) throw new Error("On-chain channel claims do not match broker-recorded liability");
            if (after.receiverAggregateSettledBaseUnits !== after.receiverAggregateClaimedBaseUnits) throw new Error("The receiver still has claimed but unsettled revenue");
            const increase = BigInt(after.receiverAggregateSettledBaseUnits) - BigInt(before.receiverAggregateSettledBaseUnits);
            if (increase !== BigInt(after.receiverBalanceBaseUnits) - BigInt(before.receiverBalanceBaseUnits)) throw new Error("Merchant revenue does not reconcile with the token balance change");
            const proof = { ...result, before, after, receiverIncreaseBaseUnits:String(increase) };
            journal.event(configId(cfg),id,"merchant.revenue_reconciled",proof);
            updateTask(id,"succeeded",proof);
            for(const prior of tasks().filter(t=>t.id!==id&&t.kind==="settlement"&&t.mandate_id===configId(cfg)&&t.state==="uncertain"))updateTask(prior.id,"reconciled",{originalError:prior.error,resolvedBy:id,...proof});
          } catch(e) { updateTask(id,"uncertain",undefined,messageOf(e)); journal.event(configId(cfg),id,"merchant.reconciliation_failed",{message:messageOf(e)}); }
        };
        serial = serial.then(run,run); respond(res,202,{task:taskById(id)}); return;
      }
      if (path === "/api/refund" && req.method === "POST") {
        auth.operator(principal); const body = await jsonBody(req);
        if (body.confirm !== "request_refund") throw new HttpError(400, "Explicit refund confirmation required");
        const cfg = await config();
        auth.revokeCapabilities(configId(cfg));
        const id = randomUUID();
        journal.db.prepare("INSERT INTO workspace_tasks(id,kind,mandate_id,query,state,created_at,updated_at) VALUES(?,'refund',?,'','queued',?,?)").run(id, configId(cfg), Date.now(), Date.now());
        const run = async () => {
          try {
            updateTask(id, "running"); const m = await acquireMandate(cfg, false);
            const result = await m.refund(cfg.serviceUrl); updateTask(id, "succeeded", result);
          } catch (e) { updateTask(id, "uncertain", undefined, messageOf(e)); }
        };
        serial = serial.then(run, run); respond(res, 202, { task: taskById(id) }); return;
      }
      if (path === "/api/capabilities" && req.method === "POST") {
        auth.operator(principal); const cfg = await config(), body = await jsonBody(req);
        const query = typeof body.query === "string" ? body.query : COMPARISON_QUERY;
        validateAnalyticsQuery(query);
        const finance = await readFinancial(cfg);
        if (finance.deposit !== "funded" || finance.state !== "active") throw new HttpError(409, "Confirm Ledger-funded authority before delegating to an agent");
        const cap = auth.createCapability(configId(cfg), query, Math.min(Date.parse(cfg.expiresAt), Date.now() + 3600000));
        const file = join(dataDir, `agent-${cap.id}.json`);
        await writeFile(file, JSON.stringify({ token: cap.token, broker: origin, query, mandateId: configId(cfg) }), { mode: 0o600, flag: "wx" });
        respond(res, 201, { id: cap.id, capabilityFile: relative(root, file), rawTokenReturned: false }); return;
      }
      if (path === "/api/evidence/publish" && req.method === "POST") {
        auth.operator(principal); const body = await jsonBody(req);
        if (body.confirm !== "publish_testnet_evidence") throw new HttpError(400, "Confirm testnet HCS publication and its network fee");
        const topic = process.env.MANDATE_HCS_TOPIC_ID, account = process.env.MANDATE_HEDERA_ACCOUNT_ID;
        if (!topic || !account) throw new HttpError(409, "Configure the public HCS topic and publisher account first");
        const cfg = await config(), taskId = randomUUID();
        if (tasks().some(t=>t.kind === "evidence" && ["queued","running"].includes(t.state))) throw new HttpError(409,"An evidence publication is already running");
        journal.db.prepare("INSERT INTO workspace_tasks(id,kind,mandate_id,query,state,created_at,updated_at) VALUES(?,'evidence',?,'','queued',?,?)").run(taskId,configId(cfg),Date.now(),Date.now());
        const run = async () => {
          try {
            updateTask(taskId,"running"); await ensureKeyRing();
            const {withSecret} = await import("./keyring.ts");
            const {PrivateKey} = await import("@hiero-ledger/sdk");
            const {flushOutbox} = await import("./evidence-publisher.ts");
            const financialPath = join(resolve(root,cfg.storageRoot),"broker.sqlite");
            const financialJournal = mandate?.journal ?? (existsSync(financialPath) ? new Journal(financialPath) : undefined);
            const merchantPath=merchantJournalPath();
            const merchantJournal=merchantPath ? new Journal(merchantPath) : undefined;
            try {
              const publications = await withSecret("hedera-payment",await readFile(join(root,"secrets/hedera.enc")),async bytes=>{
                const key=PrivateKey.fromStringECDSA(bytes.toString("utf8").trim().replace(/^0x/,""));
                const results=[{journal:"workspace",...(await flushOutbox(journal,{topic,account,key,limit:25}))}];
                if(financialJournal)results.push({journal:"buyer",...(await flushOutbox(financialJournal,{topic,account,key,limit:25}))});
                if(merchantJournal)results.push({journal:"merchant",...(await flushOutbox(merchantJournal,{topic,account,key,limit:25}))});
                return results;
              });
              if(publications.some(p=>p.failed>0 || p.pending>0)) {updateTask(taskId,"failed",{publications},"Publication incomplete; unresolved events remain in a durable outbox");return;}
              updateTask(taskId,"succeeded",{publications,network:"hedera:testnet",topic});
            } finally {if(financialJournal && financialJournal!==mandate?.journal)financialJournal.close();merchantJournal?.close();}
          } catch(e) {updateTask(taskId,"failed",undefined,messageOf(e));}
        };
        serial=serial.then(run,run);respond(res,202,{task:taskById(taskId)});return;
      }
      throw new HttpError(404, "Unknown operator route");
    } catch (e) {
      if (!res.headersSent) respond(res, e instanceof HttpError ? e.status : 400, { error: messageOf(e) });
      else res.end();
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return { server, journal, dataDir, close: async () => {
    shuttingDown = true;
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await serial; mandate?.close(); releaseOwner(); journal.close();
  } };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const port = Number(process.env.MANDATE_CONSOLE_PORT ?? 8410);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid console port");
  const app = await createOperatorApp({ root, dataDir: process.env.MANDATE_OPERATOR_STATE, port });
  app.server.listen(port, "127.0.0.1", () => {
    const bound = (app.server.address() as { port: number }).port;
    console.log(`Mandate workspace http://127.0.0.1:${bound} (no signing or payments at startup)`);
  });
  let closing = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
    if (closing) return; closing = true;
    void app.close().then(() => process.exit(0), () => process.exit(1));
  });
}
