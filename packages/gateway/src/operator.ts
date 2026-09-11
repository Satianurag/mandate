/** Authenticated, loopback-only operator workspace. Startup performs no signing or payments. */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, mkdir, rename, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import { createPublicClient, getAddress, http, erc20Abi, type Address, type Hex } from "viem";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { Journal, digest, type OutboxRow } from "./journal.ts";
import { parseMandateFile, scopeOf, type MandateFile } from "./mandate-config.ts";
import { openMandate, resumeMandate, type Mandate } from "./mandate.ts";
import { assertPaymentScope } from "./scope.ts";
import { validateAnalyticsQuery } from "./query-scope.ts";
import { AGENT0_SAMPLE_QUERY, loadSealedGraphKey } from "./analytics.ts";
import { resolveDiscoveredSubgraphs } from "./reputation.ts";
import {
  assessResearchSource, buildDueDiligenceBrief, compileResearchQuery, normalizeResearchTask, validateResearchSource,
  type ResearchPayload, type ResearchSourceScope, type ResearchTaskSpecV1,
} from "./research-task.ts";
import { HttpError, OperatorAuth, type Principal } from "./operator-auth.ts";
import type {
  ConfirmedWithdrawal,
  PreparedWithdrawalTransaction,
  WithdrawalAssessment,
} from "./withdrawal.ts";
import type { LedgerWithdrawalSigningResult } from "./dmksigner.ts";
import type { ChannelSnapshot } from "./reconciliation.ts";

export const COMPARISON_QUERY = `{ agents(first: 5, orderBy: totalFeedback, orderDirection: desc) { id agentId agentWallet totalFeedback feedback(first: 5, orderBy: createdAt, orderDirection: desc) { value isRevoked } } _meta { block { number } } }`;
interface TaskRow {
  id: string; kind: string; mandate_id: string; capability_id: string | null; query: string;
  task_spec: string | null; intent_hash: string | null;
  state: string; result: string | null; error: string | null; created_at: number; updated_at: number;
}
interface TaskIntent { query: string; spec: ResearchTaskSpecV1 | null; authorityHash: string }
export interface OperatorWithdrawalRuntime {
  prepare(input: { cfg: MandateFile; channelId: Hex; payerAuthorizer: Address; liabilityBaseUnits: string }): Promise<{
    assessment: WithdrawalAssessment;
    transaction: PreparedWithdrawalTransaction;
    snapshot: ChannelSnapshot;
  }>;
  readCurrent(input: { plan: PreparedWithdrawalTransaction; cfg: MandateFile; payerAuthorizer: Address; liabilityBaseUnits: string }): Promise<{
    assessment: WithdrawalAssessment;
    snapshot: ChannelSnapshot;
    currentNonce: number;
    currentNativeBalanceWei: bigint;
  }>;
  sign(plan: PreparedWithdrawalTransaction, expectedAddress: Address): Promise<LedgerWithdrawalSigningResult>;
  broadcast(input: { cfg: MandateFile; plan: PreparedWithdrawalTransaction; signedSerialized: Hex; expectedTransactionHash: Hex }): Promise<ConfirmedWithdrawal>;
  confirm(input: { cfg: MandateFile; plan: PreparedWithdrawalTransaction; transactionHash: Hex }): Promise<ConfirmedWithdrawal>;
}
export interface OperatorOptions {
  root: string; dataDir?: string; port?: number;
  /** Hermetic injection for tests. Production uses the sealed Graph key and live Subgraph MCP discovery. */
  discoverResearchSources?: () => Promise<Record<string, string>>;
  /** Hermetic lifecycle injection. The production runtime remains explicit prepare -> Ledger sign -> broadcast -> confirm. */
  withdrawalRuntime?: OperatorWithdrawalRuntime;
}
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

export function filterMerchantEvidenceEvents(events: OutboxRow[], channelId: string | null): OutboxRow[] {
  if (!channelId) return [];
  const expected = channelId.toLowerCase();
  const directChannel = (event: OutboxRow): string | null => {
    try {
      const data = JSON.parse(event.data) as {
        channelId?: unknown;
        before?: { channelId?: unknown };
        after?: { channelId?: unknown };
        receipt?: { extra?: { channelState?: { channelId?: unknown } } };
      };
      for (const candidate of [data.channelId, data.before?.channelId, data.after?.channelId, data.receipt?.extra?.channelState?.channelId]) {
        if (typeof candidate === "string" && /^0x[0-9a-fA-F]{64}$/.test(candidate)) return candidate.toLowerCase();
      }
    } catch { /* Journal data is validated elsewhere; malformed evidence is simply not attributed. */ }
    return null;
  };
  const requestIds = new Set(events.filter(event => directChannel(event) === expected).map(event => event.request_id).filter((id): id is string => Boolean(id)));
  return events.filter(event => directChannel(event) === expected || Boolean(event.request_id && requestIds.has(event.request_id)));
}

export function resolvePreflightReview(input: Record<string, unknown>, currentConfig: MandateFile | null) {
  const allowed = new Set(["reviewDraft", "rpcUrl", "serviceUrl", "operatorAddress", "sessionKey", "researchSource"]);
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) throw new HttpError(400, `Unsupported preflight field ${JSON.stringify(field)}`);
  }
  if (input.reviewDraft !== undefined && typeof input.reviewDraft !== "boolean") throw new HttpError(400, "reviewDraft must be boolean");
  const reviewDraft = input.reviewDraft === true;
  const rpcUrl = typeof input.rpcUrl === "string" ? input.rpcUrl.trim() : reviewDraft ? "" : currentConfig?.rpcUrl ?? "https://sepolia.base.org";
  const serviceUrl = typeof input.serviceUrl === "string" ? input.serviceUrl.trim() : reviewDraft ? "" : currentConfig?.serviceUrl ?? "http://127.0.0.1:8405/analytics";
  if (!rpcUrl || !serviceUrl) throw new HttpError(400, "Draft review requires explicit RPC and service URLs");
  for (const raw of [rpcUrl, serviceUrl]) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new HttpError(400, "Probe targets must be valid URLs"); }
    if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
      throw new HttpError(400, "Probe targets must use HTTPS or loopback HTTP");
    }
  }
  if (reviewDraft) {
    let operatorAddress: Address;
    try { operatorAddress = getAddress(String(input.operatorAddress ?? "")); }
    catch { throw new HttpError(400, "Draft review requires a valid payer address"); }
    const sessionKey = typeof input.sessionKey === "string" ? input.sessionKey.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionKey)) throw new HttpError(400, "Draft review requires a safe Key Ring session name");
    let researchSource: ResearchSourceScope;
    try { researchSource = validateResearchSource(input.researchSource); }
    catch (error) { throw new HttpError(400, messageOf(error)); }
    return Object.freeze({
      mode: "draft_review" as const,
      rpcUrl,
      serviceUrl,
      operatorAddress,
      sessionKey,
      researchSource,
      scopeConfig: null,
    });
  }
  return Object.freeze({
    mode: "current_mandate" as const,
    rpcUrl,
    serviceUrl,
    operatorAddress: currentConfig?.operatorAddress ?? null,
    sessionKey: currentConfig?.sessionKey ?? "mandate-session",
    researchSource: currentConfig?.researchSource ?? null,
    scopeConfig: currentConfig,
  });
}
export async function createOperatorApp(options: OperatorOptions): Promise<OperatorApp> {
  const root = resolve(options.root), dataDir = resolve(options.dataDir ?? join(root, "state/live/operator"));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const configPath = join(dataDir, "active-mandate.yaml");
  const journal = new Journal(join(dataDir, "workspace.sqlite"));
  const releaseOwner = journal.own("operator-workspace");
  const auth = new OperatorAuth(journal, dataDir);
  journal.db.exec(`CREATE TABLE IF NOT EXISTS workspace_tasks (
    id TEXT PRIMARY KEY,kind TEXT NOT NULL,mandate_id TEXT NOT NULL,capability_id TEXT,
    query TEXT NOT NULL,task_spec TEXT,intent_hash TEXT,state TEXT NOT NULL,result TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);`);
  const taskColumns = new Set((journal.db.prepare("PRAGMA table_info(workspace_tasks)").all() as Array<{ name: string }>).map(column => column.name));
  if (!taskColumns.has("task_spec")) journal.db.exec("ALTER TABLE workspace_tasks ADD COLUMN task_spec TEXT");
  if (!taskColumns.has("intent_hash")) journal.db.exec("ALTER TABLE workspace_tasks ADD COLUMN intent_hash TEXT");
  journal.db.prepare("UPDATE workspace_tasks SET state='interrupted',error='Broker restarted; reconcile this request before retrying',updated_at=? WHERE state IN ('queued','running','awaiting_device','awaiting_signature','awaiting_broadcast')").run(Date.now());
  let mandate: Mandate | undefined;
  let serial: Promise<unknown> = Promise.resolve();
  let shuttingDown = false;
  const signedWithdrawals = new Map<string, {
    planHash: string;
    signedSerialized: Hex;
    transactionHash: Hex;
    signer: Address;
    expiresAt: number;
  }>();
  const withdrawalRuntime: OperatorWithdrawalRuntime = options.withdrawalRuntime ?? {
    prepare: async input => {
      const { snapshotChannel } = await import("./reconciliation.ts");
      const { prepareWithdrawalTransaction } = await import("./withdrawal.ts");
      const snapshot = await snapshotChannel({
        rpcUrl: input.cfg.rpcUrl,
        chainId: 84532,
        channelId: input.channelId,
        asset: input.cfg.asset,
        payer: input.cfg.operatorAddress,
        receiver: input.cfg.receiver,
      });
      return { ...(await prepareWithdrawalTransaction({
        cfg: input.cfg,
        payerAuthorizer: input.payerAuthorizer,
        snapshot,
        liabilityBaseUnits: input.liabilityBaseUnits,
      })), snapshot };
    },
    readCurrent: async input => (await import("./withdrawal.ts")).readPreparedWithdrawalCurrent(input),
    sign: async (plan, expectedAddress) => (await import("./dmksigner.ts")).signLedgerWithdrawalTransaction(plan, expectedAddress),
    broadcast: async input => (await import("./withdrawal.ts")).broadcastSignedWithdrawal(input),
    confirm: async input => (await import("./withdrawal.ts")).confirmWithdrawalTransaction(input),
  };
  const tasks = () => journal.db.prepare("SELECT * FROM workspace_tasks ORDER BY created_at DESC LIMIT 100").all() as unknown as TaskRow[];
  const tasksForMandate = (mandateId: string) => journal.db.prepare("SELECT * FROM workspace_tasks WHERE mandate_id=? ORDER BY created_at DESC LIMIT 100").all(mandateId) as unknown as TaskRow[];
  const historicalTaskCount = (mandateId: string) => Number((journal.db.prepare("SELECT COUNT(*) AS n FROM workspace_tasks WHERE mandate_id != ?").get(mandateId) as { n?: number } | undefined)?.n ?? 0);
  const taskById = (id: string) => journal.db.prepare("SELECT * FROM workspace_tasks WHERE id=?").get(id) as unknown as TaskRow | undefined;
  const parseTaskSpec = (task: TaskRow): unknown => task.task_spec ? JSON.parse(task.task_spec) : null;
  const isWithdrawalTask = (task: TaskRow | undefined): task is TaskRow => Boolean(task && ["withdrawal_initiate", "withdrawal_finalize"].includes(task.kind));
  const withdrawalPlan = (task: TaskRow): PreparedWithdrawalTransaction => {
    if (!isWithdrawalTask(task) || !task.task_spec) throw new Error("Withdrawal task has no reviewed transaction plan");
    return JSON.parse(task.task_spec) as PreparedWithdrawalTransaction;
  };
  const publicTaskSpec = (task: TaskRow): unknown => {
    const spec = parseTaskSpec(task);
    if (!isWithdrawalTask(task) || !spec || typeof spec !== "object" || Array.isArray(spec)) return spec;
    const { unsignedSerialized: _unsignedSerialized, ...publicPlan } = spec as PreparedWithdrawalTransaction;
    return publicPlan;
  };
  const taskForApi = (task: TaskRow | undefined) => task ? ({ ...task, task_spec: undefined, intent_hash: undefined, task: publicTaskSpec(task) }) : undefined;
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
      const events = j.events(configId(cfg));
      const returned = events.find(e => e.kind === "refund.transaction_confirmed" || e.kind === "withdrawal.transaction_confirmed");
      const pendingWithdrawal = events.find(e => e.kind === "withdrawal.initiated");
      return { state: row?.state ?? "not_funded", deposit: row?.deposit ?? "none", ...totals,
        refundedBaseUnits: returned ? JSON.parse(returned.data).returnedBaseUnits ?? "0" : "0",
        withdrawal: pendingWithdrawal ? JSON.parse(pendingWithdrawal.data) : null,
        channelId: row?.channel_id ?? null, payer: row?.payer ?? null, session: row?.session ?? null,
        requests: j.requests(configId(cfg)), events, eventChainValid: j.verifyEventChain(), pendingAnchors: j.pendingCount() };
    } finally { if (j !== mandate?.journal) j.close(); }
  }
  function merchantJournalPath(): string | null {
    const configured=process.env.MANDATE_LOCAL_MERCHANT_STATE;
    if (!configured || !process.env.MANDATE_LOCAL_MERCHANT_URL) return null;
    const path=join(resolve(root,configured),"merchant.sqlite");
    return existsSync(path) ? path : null;
  }
  function readMerchantEvidence(channelId: string | null): {events: OutboxRow[];eventChainValid: boolean;pendingAnchors: number;totalEvents: number;historicalEventsExcluded: number;scopedChannelId: string | null} {
    const path=merchantJournalPath();
    if (!path) return {events:[],eventChainValid:true,pendingAnchors:0,totalEvents:0,historicalEventsExcluded:0,scopedChannelId:channelId};
    const j=new Journal(path);
    try {
      const allEvents = j.events();
      const events = filterMerchantEvidenceEvents(allEvents, channelId);
      return {events,eventChainValid:j.verifyEventChain(),pendingAnchors:j.pendingCount(),totalEvents:allEvents.length,
        historicalEventsExcluded:allEvents.length-events.length,scopedChannelId:channelId};
    }
    finally { j.close(); }
  }
  async function evidencePublicationPlan(finance: Record<string, unknown> | null, merchantEvidence: {pendingAnchors:number}) {
    const { planEvidenceBatch } = await import("./evidence-publisher.ts");
    return planEvidenceBatch([
      { journal: "workspace", pending: journal.pendingCount() },
      { journal: "buyer", pending: Number(finance?.pendingAnchors ?? 0) },
      { journal: "merchant", pending: merchantEvidence.pendingAnchors },
    ]);
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
  async function discoverResearchSources(): Promise<Record<string, string>> {
    const discovered = options.discoverResearchSources ? await options.discoverResearchSources() : await (async () => {
      await ensureKeyRing();
      const key = await loadSealedGraphKey();
      if (!key) throw new Error("Graph API key is not sealed; research sources cannot be verified");
      return resolveDiscoveredSubgraphs(key);
    })();
    const verified: Record<string, string> = {};
    for (const [chain, deployment] of Object.entries(discovered)) {
      try {
        const source = validateResearchSource({ provider: "the-graph", chain, deployment });
        verified[source.chain] = source.deployment;
      } catch { /* Ignore unrelated or malformed discovery rows. */ }
    }
    if (!Object.keys(verified).length) throw new Error("Live discovery returned no supported Agent0 testnet deployment");
    return verified;
  }
  function defaultResearchTask(cfg: MandateFile): ResearchTaskSpecV1 | null {
    return cfg.researchSource ? normalizeResearchTask({
      version: 1, template: "agent0-due-diligence", source: cfg.researchSource, maxResults: 5,
    }, cfg.researchSource) : null;
  }
  function resolveTaskIntent(cfg: MandateFile, body: Record<string, unknown>): TaskIntent {
    if (cfg.researchSource) {
      if (body.query !== undefined) throw new HttpError(400, "Raw GraphQL is not accepted for a source-bound mandate");
      const spec = normalizeResearchTask(body.task, cfg.researchSource);
      const query = compileResearchQuery(spec);
      validateAnalyticsQuery(query);
      return { query, spec, authorityHash: digest(spec) };
    }
    if (body.task !== undefined) throw new HttpError(409, "This legacy mandate has no reviewed research source; create a new source-bound mandate before new paid work");
    const query = typeof body.query === "string" ? body.query : COMPARISON_QUERY;
    validateAnalyticsQuery(query);
    return { query, spec: null, authorityHash: digest(query) };
  }
  function taskResult(cfg: MandateFile, task: TaskRow, body: unknown, m: Mandate, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const completedAt = new Date().toISOString();
    if (!task.task_spec || !cfg.researchSource || !body || typeof body !== "object" || Array.isArray(body)) {
      return { data: body, requestId: task.id, completedAt, ...extra };
    }
    const spec = normalizeResearchTask(JSON.parse(task.task_spec), cfg.researchSource);
    const totals = m.journal.totals(configId(cfg), cfg.windowMs);
    const remaining = BigInt(cfg.ceilingBaseUnits) - BigInt(totals.spent) - BigInt(totals.reserved);
    const request = m.journal.request(task.id);
    const accounting = {
      requestId: task.id,
      paidCalls: request?.state === "accepted" ? 1 : 0,
      acceptedCostBaseUnits: request?.charged ?? "0",
      reservedBaseUnits: totals.reserved,
      remainingAuthorityBaseUnits: String(remaining > 0n ? remaining : 0n),
      ceilingBaseUnits: cfg.ceilingBaseUnits,
      completedAt,
    };
    const evidence = body as ResearchPayload;
    return {
      schemaVersion: 1,
      requestId: task.id,
      task: spec,
      brief: buildDueDiligenceBrief(spec, evidence, accounting),
      evidence,
      completedAt,
      ...extra,
    };
  }
  const activeTaskStates = new Set(["queued", "running", "awaiting_device", "awaiting_signature", "awaiting_broadcast"]);
  const terminalTaskStates = new Set(["succeeded", "failed", "blocked", "reconciled", "cancelled"]);
  const taskResultObject = (task: TaskRow): Record<string, unknown> => {
    if (!task.result) return {};
    try {
      const parsed = JSON.parse(task.result);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  };
  const financialJournal = (cfg: MandateFile): Journal => new Journal(join(resolve(root, cfg.storageRoot), "broker.sqlite"));
  const assertNoOtherActiveTask = (mandateId: string, excludeId?: string) => {
    const active = tasks().find(task => task.id !== excludeId && task.mandate_id === mandateId && activeTaskStates.has(task.state));
    if (active) throw new HttpError(409, `Task ${active.id} is ${active.state}; finish or reconcile it first`);
  };
  async function stopAuthorityForWithdrawal(cfg: MandateFile): Promise<void> {
    const mandateId = configId(cfg);
    auth.revokeCapabilities(mandateId);
    if (mandate) {
      mandate.stop();
      mandate.close();
      mandate = undefined;
      await new Promise(resolveNow => setImmediate(resolveNow));
    } else {
      const path = join(resolve(root, cfg.storageRoot), "broker.sqlite");
      if (existsSync(path)) {
        const j = new Journal(path);
        try { if (j.mandate(mandateId)) j.stop(mandateId); } finally { j.close(); }
      }
    }
    journal.event(mandateId, null, "withdrawal.authority_stopped", {
      newRequestsBlocked: true,
      capabilitiesRevoked: true,
      acceptedPaymentsReversed: false,
    });
  }
  function verifyPreparedWithdrawal(cfg: MandateFile, finance: Record<string, unknown>, transaction: PreparedWithdrawalTransaction): void {
    if (transaction.network !== cfg.network || transaction.chainId !== 84532) throw new Error("Prepared withdrawal is not Base Sepolia");
    if (String(finance.channelId).toLowerCase() !== transaction.channelId.toLowerCase()) throw new Error("Prepared withdrawal is for another channel");
    if (getAddress(transaction.payer) !== getAddress(cfg.operatorAddress)) throw new Error("Prepared withdrawal is for another payer");
    if (!/^[a-f0-9]{64}$/.test(transaction.planHash)) throw new Error("Prepared withdrawal plan hash is malformed");
  }
  function storeWithdrawalPlan(taskId: string, transaction: PreparedWithdrawalTransaction, state: string, result: Record<string, unknown>): void {
    journal.db.prepare("UPDATE workspace_tasks SET kind=?,task_spec=?,intent_hash=?,state=?,result=?,error=NULL,updated_at=? WHERE id=?")
      .run(`withdrawal_${transaction.kind}`, JSON.stringify(transaction), transaction.planHash, state, JSON.stringify(result), Date.now(), taskId);
  }
  function recordConfirmedWithdrawal(cfg: MandateFile, task: TaskRow, proof: ConfirmedWithdrawal, taskState: "succeeded" | "reconciled", prior: Record<string, unknown>): void {
    const mandateId = configId(cfg);
    const j = financialJournal(cfg);
    try {
      if (proof.kind === "initiate") j.withdrawalInitiated(mandateId, proof);
      else j.withdrawalFinalized(mandateId, proof);
    } finally { j.close(); }
    const result = { ...prior, phase: "confirmed", proof, newTransaction: taskState === "succeeded", confirmedAt: new Date().toISOString() };
    updateTask(task.id, taskState, result);
    journal.event(mandateId, task.id, proof.kind === "initiate" ? "withdrawal.initiation_confirmed" : "withdrawal.finalization_confirmed", {
      transaction: proof.transaction,
      planHash: task.intent_hash,
      newTransaction: taskState === "succeeded",
    });
  }
  async function reconcileWithdrawalTask(cfg: MandateFile, task: TaskRow): Promise<Record<string, unknown>> {
    const finance = await readFinancial(cfg);
    if (!finance.session) throw new HttpError(409, "Pinned payer authorizer is unavailable; do not construct a replacement channel");
    const plan = withdrawalPlan(task);
    const prior = taskResultObject(task);
    if (["succeeded", "reconciled"].includes(task.state)) return { task: taskForApi(task), newTransaction: false, alreadyConfirmed: true };
    if (task.state === "awaiting_broadcast") return { task: taskForApi(task), newTransaction: false, actionRequired: "broadcast_reviewed_transaction" };
    if (task.state === "interrupted" && prior.broadcastAttempted !== true) {
      await withdrawalRuntime.readCurrent({
        plan,
        cfg,
        payerAuthorizer: getAddress(String(finance.session)),
        liabilityBaseUnits: String(finance.spent ?? "0"),
      });
      signedWithdrawals.delete(task.id);
      updateTask(task.id, "prepared", { ...prior, phase: "prepared", signatureRetained: false, broadcastAttempted: false,
        reconciledAt: new Date().toISOString(), reconciliation: "No broadcast was started before interruption; the exact plan was revalidated and requires a new Ledger signature." });
      return { task: taskForApi(taskById(task.id)), newTransaction: false, signatureRequested: false, resetToPrepared: true };
    }
    if (task.state !== "uncertain") throw new HttpError(409, `Withdrawal task is ${task.state}; there is no submitted transaction to reconcile`);
    const transactionHash = prior.transactionHash;
    if (typeof transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) throw new HttpError(409, "Uncertain withdrawal has no valid original transaction hash; do not create a replacement");
    try {
      const proof = await withdrawalRuntime.confirm({ cfg, plan, transactionHash: transactionHash as Hex });
      recordConfirmedWithdrawal(cfg, task, proof, "reconciled", prior);
      return { task: taskForApi(taskById(task.id)), proof, newTransaction: false };
    } catch (error) {
      throw new HttpError(409, `The original withdrawal remains unresolved; no replacement was sent: ${messageOf(error)}`);
    }
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
  function enqueueTask(cfg: MandateFile, intent: TaskIntent, principal: Principal, authorizeFunding: boolean, id: string): TaskRow {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new HttpError(400, "Invalid task idempotency key");
    const mandateId = configId(cfg);
    if (principal.role === "agent" && (principal.mandateId !== mandateId || principal.authorityHash !== intent.authorityHash)) throw new HttpError(403, "This task is outside the agent's scoped capability");
    if (principal.role === "agent" && authorizeFunding) throw new HttpError(403, "Agents cannot request Ledger funding");
    const prior = taskById(id);
    if (prior) {
      const priorAuthorityHash = prior.intent_hash ?? digest(prior.task_spec ? JSON.parse(prior.task_spec) : prior.query);
      if (priorAuthorityHash !== intent.authorityHash || prior.query !== intent.query || prior.mandate_id !== mandateId || prior.capability_id !== (principal.role === "agent" ? principal.capabilityId : null)) {
        throw new HttpError(409, "Idempotency key is bound to another task");
      }
      return prior;
    }
    if (tasks().filter(t => ["queued","running","awaiting_device","awaiting_signature","awaiting_broadcast"].includes(t.state)).length >= 10) throw new HttpError(429, "Task queue is full");
    journal.db.prepare("INSERT INTO workspace_tasks(id,kind,mandate_id,capability_id,query,task_spec,intent_hash,state,created_at,updated_at) VALUES(?,'query',?,?,?,?,?,'queued',?,?)")
      .run(id, mandateId, principal.role === "agent" ? principal.capabilityId : null, intent.query, intent.spec ? JSON.stringify(intent.spec) : null, intent.authorityHash, Date.now(), Date.now());
    journal.event(mandateId, id, "task.queued", { task: intent.spec, queryHash: digest(intent.query), authorityHash: intent.authorityHash, actor: principal.role, authorizeFunding });
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
        const url = new URL(cfg.serviceUrl); url.searchParams.set("q", intent.query);
        if (intent.spec) {
          url.searchParams.set("sourceChain", intent.spec.source.chain);
          url.searchParams.set("sourceDeployment", intent.spec.source.deployment);
        }
        const response = await m.fetch(url, { headers: { "idempotency-key": id } });
        const text = await response.text();
        let body: unknown;
        try { body = JSON.parse(text); } catch { body = { body: text }; }
        if (!response.ok) throw new Error(`Paid service returned HTTP ${response.status}: ${text.slice(0, 500)}`);
        const task = taskById(id)!;
        const result = taskResult(cfg, task, body, m, { status: response.status, paymentResponse: response.headers.get("payment-response") });
        updateTask(id, "succeeded", result);
        journal.event(mandateId, id, "task.succeeded", { responseHash: digest(body), resultHash: digest(result) });
      } catch (e) {
        const request = mandate?.journal.request(id);
        const state = request && ["signed","uncertain"].includes(request.state) ? "uncertain" : /budget exhausted|limit exceeded|outside the mandate|expired|new spending is blocked|closed|research source/i.test(messageOf(e)) ? "blocked" : "failed";
        updateTask(id, state, undefined, messageOf(e));
        journal.event(mandateId, id, `task.${state}`, { message: messageOf(e) });
      }
    };
    serial = serial.then(run, run);
    return taskById(id)!;
  }
  async function preflight(input: Record<string, unknown>): Promise<unknown> {
    const currentConfig = await config().catch(() => null);
    const review = resolvePreflightReview(input, currentConfig);
    const result: Record<string, unknown> = {
      mode: review.mode,
      observedAt: new Date().toISOString(),
      signingAttempted: false,
      paid: false,
    };
    if (review.researchSource) {
      try {
        result.research = assessResearchSource(review.researchSource, await discoverResearchSources());
      } catch (error) {
        result.research = {
          ok: false,
          status: "discovery_failed",
          source: review.researchSource,
          discoveredDeployment: null,
          fallbackAllowed: false,
          error: messageOf(error),
        };
      }
    } else if (review.scopeConfig) {
      result.research = {
        ok: false,
        status: "legacy_unbound",
        source: null,
        discoveredDeployment: null,
        fallbackAllowed: false,
        error: "This legacy mandate has no reviewed research source; new paid research is blocked",
      };
    }

    const rpc = createPublicClient({ transport: http(review.rpcUrl, { timeout: 10000, retryCount: 0 }) });
    let chainId: number | null = null;
    try {
      chainId = await rpc.getChainId();
      result.chain = { chainId, expected: 84532, ok: chainId === 84532 };
    } catch (error) {
      result.chain = { ok: false, error: messageOf(error) };
    }

    let payment: ReturnType<typeof decodePaymentRequiredHeader>["accepts"][number] | undefined;
    const task = review.researchSource ? normalizeResearchTask({
      version: 1,
      template: "agent0-due-diligence",
      source: review.researchSource,
      maxResults: 5,
    }, review.researchSource) : null;
    try {
      const probeUrl = new URL(review.serviceUrl);
      if (task) {
        probeUrl.searchParams.set("q", compileResearchQuery(task));
        probeUrl.searchParams.set("sourceChain", task.source.chain);
        probeUrl.searchParams.set("sourceDeployment", task.source.deployment);
      }
      const response = await fetch(probeUrl, { redirect: "error", signal: AbortSignal.timeout(10000) });
      if (response.status !== 402) throw new Error(`Expected an unsigned 402 offer, got HTTP ${response.status}`);
      const offer = decodePaymentRequiredHeader(response.headers.get("payment-required") ?? "");
      payment = offer.accepts.find(candidate => candidate.scheme === "batch-settlement" && candidate.network === "eip155:84532");
      if (!payment) throw new Error("Service does not offer Base Sepolia batch settlement");
      result.service = {
        ok: true,
        status: response.status,
        requirements: payment,
        sourceBound: Boolean(task),
        source: task?.source ?? null,
      };
    } catch (error) {
      result.service = { ok: false, error: messageOf(error) };
    }

    if (review.scopeConfig && payment) {
      try {
        assertPaymentScope(scopeOf(review.scopeConfig), payment);
        result.scopeMatches = true;
        result.authorityScope = { ok: true };
      } catch (error) {
        result.scopeMatches = false;
        result.authorityScope = { ok: false, error: messageOf(error) };
      }
    }
    if (review.researchSource) result.researchMatches = (result.research as { ok?: boolean } | undefined)?.ok === true;

    if (chainId === 84532 && payment) {
      try {
        const asset = getAddress(payment.asset);
        const receiver = getAddress(payment.payTo);
        const [symbol, decimals, payerBalance, receiverBalance] = await Promise.all([
          rpc.readContract({ address: asset, abi: erc20Abi, functionName: "symbol" }),
          rpc.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" }),
          review.operatorAddress
            ? rpc.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [review.operatorAddress] })
            : Promise.resolve(null),
          rpc.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [receiver] }),
        ]);
        result.token = {
          asset,
          receiver,
          symbol,
          decimals,
          payer: review.operatorAddress,
          payerBalance: payerBalance === null ? null : String(payerBalance),
          receiverBalance: String(receiverBalance),
        };
      } catch (error) {
        result.token = { ok: false, error: messageOf(error) };
      }
    }

    result.sealedSessionPresent = await access(join(root, "secrets", `${review.sessionKey}.enc`)).then(() => true, () => false);
    journal.event(review.mode === "current_mandate" && currentConfig ? configId(currentConfig) : "setup", null, "operator.preflight", result);
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
        const currentMandateId = cfg ? configId(cfg) : null;
        const financial = cfg ? await readFinancial(cfg) : null;
        const channelId = typeof financial?.channelId === "string" ? financial.channelId : null;
        const merchantEvidence=readMerchantEvidence(channelId);
        const evidencePublication = await evidencePublicationPlan(financial, merchantEvidence);
        const currentTasks = currentMandateId ? tasksForMandate(currentMandateId) : [];
        const currentEvents = currentMandateId ? journal.events(currentMandateId) : [];
        const historicalWorkspaceEventCount = currentMandateId
          ? Number((journal.db.prepare("SELECT COUNT(*) AS n FROM events WHERE mandate_id != ?").get(currentMandateId) as { n?: number } | undefined)?.n ?? 0)
          : Number((journal.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n?: number } | undefined)?.n ?? 0);
        respond(res, 200, { version: 4, observedAt: new Date().toISOString(), config: cfg, mandateId: currentMandateId,
          financial, tasks: currentTasks.map(taskForApi), historicalTaskCount: currentMandateId ? historicalTaskCount(currentMandateId) : tasks().length,
          legacy: await legacyInfo(), merchantEvidence, evidencePublication,
          defaultTask: cfg ? defaultResearchTask(cfg) : null, comparisonQuery: COMPARISON_QUERY, events: currentEvents,
          historicalWorkspaceEventCount, eventChainValid: journal.verifyEventChain(),
          csrf: principal.role === "operator" ? principal.csrf : null,
          boundary: "Ledger signs funding; the broker enforces resource, expiry and rolling limits. Voucher acceptance is not merchant revenue.",
          merchantLifecycleAvailable: Boolean(process.env.MANDATE_LOCAL_MERCHANT_URL && process.env.MANDATE_MERCHANT_ADMIN_TOKEN_FILE),
          configPath: relative(root, configPath), hcsConfigured: Boolean(process.env.MANDATE_HCS_TOPIC_ID && process.env.MANDATE_HEDERA_ACCOUNT_ID) }); return;
      }
      if (path === "/api/research/sources" && req.method === "GET") {
        auth.operator(principal);
        const sources = await discoverResearchSources();
        respond(res, 200, { observedAt: new Date().toISOString(), provider: "the-graph", sources: Object.entries(sources).map(([chain, deployment]) => ({ chain, deployment })) }); return;
      }
      if (path === "/api/config" && req.method === "POST") {
        auth.operator(principal);
        const body = await jsonBody(req);
        if (body.network !== undefined && body.network !== "eip155:84532") throw new HttpError(400,"This workspace is Base Sepolia testnet-only");
        const requestedSource = validateResearchSource(body.researchSource);
        const discoveredSources = await discoverResearchSources();
        if (discoveredSources[requestedSource.chain] !== requestedSource.deployment) throw new HttpError(409, "Research deployment does not match live Agent0 discovery; refresh sources and review again");
        body.researchSource = requestedSource;
        if (tasks().some(t => ["running","awaiting_device","awaiting_signature","awaiting_broadcast","queued"].includes(t.state))) throw new HttpError(409, "Finish or stop current work before changing authority");
        const previous = await config().catch(() => null);
        if (previous) {
          const f = await readFinancial(previous);
          if (f.deposit !== "none" && !["refunded", "closed"].includes(String(f.state))) throw new HttpError(409, "Recover or close the previous mandate before replacing its configuration");
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
        if (Object.keys(body).some(k => !["task","query","authorizeFunding","requestId"].includes(k))) throw new HttpError(400, "Task fields cannot override receiver, URL, asset or limits");
        const intent = resolveTaskIntent(cfg, body);
        const row = enqueueTask(cfg, intent, principal, body.authorizeFunding === true, typeof body.requestId === "string" ? body.requestId : randomUUID());
        respond(res, 202, { task: taskForApi(row) }); return;
      }
      if (path === "/api/withdrawals/prepare" && req.method === "POST") {
        auth.operator(principal); const body = await jsonBody(req);
        if (body.confirm !== "prepare_timed_withdrawal_testnet") throw new HttpError(400, "Explicit timed-withdrawal preparation confirmation required");
        const cfg = await config(), mandateId = configId(cfg);
        assertNoOtherActiveTask(mandateId);
        const unresolved = tasks().find(task => task.mandate_id === mandateId && task.kind.startsWith("withdrawal_") && !terminalTaskStates.has(task.state));
        if (unresolved) throw new HttpError(409, `Withdrawal task ${unresolved.id} is ${unresolved.state}; finish or reconcile it first`);
        const finance = await readFinancial(cfg);
        if (finance.deposit !== "funded" || !finance.channelId || !finance.session || !finance.payer) throw new HttpError(409, "A confirmed Ledger-funded channel with pinned identities is required");
        if (["refunded", "closed"].includes(String(finance.state))) throw new HttpError(409, `Mandate is already ${finance.state}`);
        const id = typeof body.requestId === "string" ? body.requestId : randomUUID();
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new HttpError(400, "Invalid withdrawal preparation idempotency key");
        if (taskById(id)) throw new HttpError(409, "Withdrawal preparation id is already bound to another task");
        journal.db.prepare("INSERT INTO workspace_tasks(id,kind,mandate_id,query,state,created_at,updated_at) VALUES(?,'withdrawal_prepare',?,'','queued',?,?)")
          .run(id, mandateId, Date.now(), Date.now());
        const run = async () => {
          try {
            updateTask(id, "running", { phase: "stopping_authority", signatureRequested: false, broadcastAttempted: false });
            await stopAuthorityForWithdrawal(cfg);
            await reconcilePriorLifecycleTasks(cfg);
            const currentFinance = await readFinancial(cfg);
            if (currentFinance.deposit !== "funded" || !currentFinance.channelId || !currentFinance.session) throw new Error("Funded channel identity changed during withdrawal preparation");
            const prepared = await withdrawalRuntime.prepare({
              cfg,
              channelId: String(currentFinance.channelId) as Hex,
              payerAuthorizer: getAddress(String(currentFinance.session)),
              liabilityBaseUnits: String(currentFinance.spent ?? "0"),
            });
            verifyPreparedWithdrawal(cfg, currentFinance, prepared.transaction);
            storeWithdrawalPlan(id, prepared.transaction, "prepared", {
              phase: "prepared",
              assessment: prepared.assessment,
              snapshot: prepared.snapshot,
              review: {
                network: prepared.transaction.network,
                contract: prepared.transaction.contract,
                payer: prepared.transaction.payer,
                channelId: prepared.transaction.channelId,
                kind: prepared.transaction.kind,
                amountBaseUnits: prepared.transaction.amountBaseUnits,
                maxGasCostWei: prepared.transaction.maxGasCostWei,
                unsignedHash: prepared.transaction.unsignedHash,
                selector: prepared.transaction.selector,
                planHash: prepared.transaction.planHash,
              },
              signatureRequested: false,
              broadcastAttempted: false,
              preparedAt: prepared.transaction.preparedAt,
            });
            journal.event(mandateId, id, "withdrawal.prepared", {
              kind: prepared.transaction.kind,
              planHash: prepared.transaction.planHash,
              unsignedHash: prepared.transaction.unsignedHash,
              channelId: prepared.transaction.channelId,
              amountBaseUnits: prepared.transaction.amountBaseUnits,
              signatureRequested: false,
              broadcastAttempted: false,
            });
          } catch (error) {
            updateTask(id, "failed", { phase: "preparation_failed", signatureRequested: false, broadcastAttempted: false }, messageOf(error));
            journal.event(mandateId, id, "withdrawal.preparation_failed", { message: messageOf(error), signatureRequested: false, broadcastAttempted: false });
          }
        };
        serial = serial.then(run, run);
        respond(res, 202, { task: taskForApi(taskById(id)), signatureRequested: false, broadcastAttempted: false }); return;
      }
      const withdrawalAction = /^\/api\/withdrawals\/([A-Za-z0-9_-]{8,128})\/(sign|broadcast)$/.exec(path);
      if (withdrawalAction && req.method === "POST") {
        auth.operator(principal); const body = await jsonBody(req), task = taskById(withdrawalAction[1]!);
        if (!task || !isWithdrawalTask(task)) throw new HttpError(404, "Withdrawal task not found");
        const cfg = await config(), mandateId = configId(cfg);
        if (task.mandate_id !== mandateId) throw new HttpError(409, "Withdrawal task belongs to another mandate");
        const plan = withdrawalPlan(task), prior = taskResultObject(task);
        if (body.planHash !== plan.planHash) throw new HttpError(409, "Withdrawal plan changed after review; refresh before continuing");
        const finance = await readFinancial(cfg);
        if (!finance.session || !finance.channelId) throw new HttpError(409, "Pinned channel identity is unavailable");
        if (withdrawalAction[2] === "sign") {
          if (body.confirm !== "sign_reviewed_withdrawal_on_ledger") throw new HttpError(400, "Explicit Ledger transaction-signing confirmation required");
          if (task.state !== "prepared") throw new HttpError(409, `Withdrawal task is ${task.state}; reconcile it before another signature`);
          assertNoOtherActiveTask(mandateId, task.id);
          updateTask(task.id, "awaiting_device", { ...prior, phase: "validating_before_signature", signatureRequested: false, broadcastAttempted: false });
          const run = async () => {
            try {
              await withdrawalRuntime.readCurrent({ plan, cfg, payerAuthorizer: getAddress(String(finance.session)), liabilityBaseUnits: String(finance.spent ?? "0") });
              updateTask(task.id, "awaiting_signature", { ...prior, phase: "awaiting_ledger", signatureRequested: true, broadcastAttempted: false });
              const signed = await withdrawalRuntime.sign(plan, getAddress(cfg.operatorAddress));
              if (getAddress(signed.signer) !== getAddress(cfg.operatorAddress) || !/^0x[0-9a-fA-F]{64}$/.test(signed.transactionHash)) throw new Error("Ledger returned an unverifiable withdrawal signature");
              const expiresAt = Date.now() + 10 * 60_000;
              signedWithdrawals.set(task.id, { planHash: plan.planHash, signedSerialized: signed.signedSerialized, transactionHash: signed.transactionHash, signer: signed.signer, expiresAt });
              updateTask(task.id, "awaiting_broadcast", {
                ...prior,
                phase: "awaiting_broadcast",
                signatureRequested: true,
                signatureVerified: true,
                signatureRetainedInMemoryUntil: new Date(expiresAt).toISOString(),
                transactionHash: signed.transactionHash,
                signer: signed.signer,
                trace: signed.trace,
                broadcastAttempted: false,
              });
              journal.event(mandateId, task.id, "withdrawal.signature_verified", {
                kind: plan.kind,
                planHash: plan.planHash,
                unsignedHash: plan.unsignedHash,
                transactionHash: signed.transactionHash,
                signer: signed.signer,
                rawSignedTransactionPersisted: false,
                broadcastAttempted: false,
              });
            } catch (error) {
              signedWithdrawals.delete(task.id);
              updateTask(task.id, "failed", { ...prior, phase: "signature_failed", signatureRequested: true, broadcastAttempted: false }, messageOf(error));
              journal.event(mandateId, task.id, "withdrawal.signature_failed", { message: messageOf(error), broadcastAttempted: false });
            }
          };
          serial = serial.then(run, run);
          respond(res, 202, { task: taskForApi(taskById(task.id)), broadcastAttempted: false }); return;
        }
        if (body.confirm !== "broadcast_reviewed_withdrawal_testnet") throw new HttpError(400, "Explicit Base Sepolia broadcast confirmation required");
        if (task.state !== "awaiting_broadcast") throw new HttpError(409, `Withdrawal task is ${task.state}; no signed transaction is ready for broadcast`);
        const envelope = signedWithdrawals.get(task.id);
        if (!envelope || envelope.expiresAt <= Date.now()) {
          signedWithdrawals.delete(task.id);
          updateTask(task.id, "interrupted", { ...prior, phase: "signature_not_retained", broadcastAttempted: false }, "The in-memory signed transaction expired or was lost; reconcile, then request a fresh Ledger signature");
          throw new HttpError(409, "Signed transaction is no longer retained; no broadcast occurred. Reconcile this task before signing again");
        }
        if (body.transactionHash !== envelope.transactionHash || envelope.planHash !== plan.planHash) throw new HttpError(409, "Broadcast confirmation does not match the Ledger-signed transaction");
        assertNoOtherActiveTask(mandateId, task.id);
        updateTask(task.id, "running", { ...prior, phase: "validating_before_broadcast", transactionHash: envelope.transactionHash, broadcastAttempted: false });
        const run = async () => {
          let attempted = false;
          try {
            await withdrawalRuntime.readCurrent({ plan, cfg, payerAuthorizer: getAddress(String(finance.session)), liabilityBaseUnits: String(finance.spent ?? "0") });
            attempted = true;
            updateTask(task.id, "uncertain", {
              ...prior,
              phase: "broadcast_started",
              transactionHash: envelope.transactionHash,
              signer: envelope.signer,
              broadcastAttempted: true,
              broadcastStartedAt: new Date().toISOString(),
            });
            journal.event(mandateId, task.id, "withdrawal.broadcast_started", {
              transactionHash: envelope.transactionHash,
              planHash: plan.planHash,
              rawSignedTransactionPersisted: false,
              reconciliationRequiredUntilConfirmed: true,
            });
            signedWithdrawals.delete(task.id);
            const proof = await withdrawalRuntime.broadcast({ cfg, plan, signedSerialized: envelope.signedSerialized, expectedTransactionHash: envelope.transactionHash });
            recordConfirmedWithdrawal(cfg, task, proof, "succeeded", { ...prior, transactionHash: envelope.transactionHash, broadcastAttempted: true });
          } catch (error) {
            signedWithdrawals.delete(task.id);
            if (attempted) {
              updateTask(task.id, "uncertain", { ...prior, phase: "broadcast_uncertain", transactionHash: envelope.transactionHash, broadcastAttempted: true }, messageOf(error));
              journal.event(mandateId, task.id, "withdrawal.broadcast_uncertain", { transactionHash: envelope.transactionHash, message: messageOf(error), replacementSent: false });
            } else {
              updateTask(task.id, "failed", { ...prior, phase: "pre_broadcast_validation_failed", transactionHash: envelope.transactionHash, broadcastAttempted: false }, messageOf(error));
              journal.event(mandateId, task.id, "withdrawal.pre_broadcast_validation_failed", { message: messageOf(error), broadcastAttempted: false });
            }
          }
        };
        serial = serial.then(run, run);
        respond(res, 202, { task: taskForApi(taskById(task.id)), transactionHash: envelope.transactionHash, confirmationPending: true }); return;
      }
      if (path.startsWith("/api/tasks/") && req.method === "GET") {
        const task = taskById(path.slice("/api/tasks/".length));
        if (!task || (principal.role === "agent" && task.capability_id !== principal.capabilityId)) throw new HttpError(404, "Task not found");
        respond(res, 200, { task: taskForApi(task) }); return;
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
        const withdrawal = requestId ? taskById(requestId) : tasks().find(task => task.mandate_id === configId(cfg) && isWithdrawalTask(task) && ["uncertain", "interrupted"].includes(task.state));
        if (withdrawal && isWithdrawalTask(withdrawal)) { respond(res, 200, await reconcileWithdrawalTask(cfg, withdrawal)); return; }
        if(typeof body.refundTransaction==="string" || (!requestId && tasks().some(t=>t.mandate_id===configId(cfg)&&t.kind==="refund"&&["uncertain","interrupted"].includes(t.state)))) {
          respond(res,200,await reconcileExistingRefund(cfg,typeof body.refundTransaction==="string"?body.refundTransaction:undefined));return;
        }
        if (tasks().some(t => ["queued","running","awaiting_device","awaiting_signature","awaiting_broadcast"].includes(t.state))) throw new HttpError(409,"Wait for the current operation before reconciling");
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
            const task = taskById(requestId);
            if (task) updateTask(requestId,"succeeded",taskResult(cfg,task,JSON.parse(response.body),m,{status:response.status,paymentResponse:response.headers["payment-response"],reconciledAt:new Date().toISOString()}));
          }
        }
        respond(res,200,result);return;
      }
      if (path === "/api/release" && req.method === "POST") {
        auth.operator(principal); await jsonBody(req);
        if (tasks().some(t => ["queued","running","awaiting_device","awaiting_signature","awaiting_broadcast"].includes(t.state))) throw new HttpError(409, "Wait for running work before releasing the client");
        if (mandate) { mandate.close(); mandate = undefined; await new Promise(resolve => setImmediate(resolve)); }
        respond(res, 200, {released:true, revoked:false, newFundingAuthorized:false}); return;
      }
      if (path === "/api/close" && req.method === "POST") {
        auth.operator(principal); const body = await jsonBody(req);
        if (body.confirm !== "close_fully_spent_testnet") throw new HttpError(400, "Explicit fully-spent closure confirmation required");
        if (tasks().some(t => ["queued","running","awaiting_device","awaiting_signature","awaiting_broadcast"].includes(t.state))) throw new HttpError(409, "Wait for running work before closing the mandate");
        const cfg = await config(), id = configId(cfg), finance = await readFinancial(cfg);
        if (!finance.channelId) throw new HttpError(409, "There is no funded channel to close");
        auth.revokeCapabilities(id);
        await reconcilePriorLifecycleTasks(cfg);
        const { snapshotChannel } = await import("./reconciliation.ts");
        const proof = await snapshotChannel({ rpcUrl: cfg.rpcUrl, chainId: 84532,
          channelId: String(finance.channelId) as `0x${string}`, asset: cfg.asset,
          payer: cfg.operatorAddress, receiver: cfg.receiver });
        const financialPath = join(resolve(root, cfg.storageRoot), "broker.sqlite");
        const j = mandate?.id === id ? mandate.journal : new Journal(financialPath);
        try { j.closeFullySpent(id, cfg.ceilingBaseUnits, proof); }
        finally { if (j !== mandate?.journal) j.close(); }
        if (mandate) { mandate.close(); mandate = undefined; await new Promise(resolveNow => setImmediate(resolveNow)); }
        journal.event(id, null, "operator.mandate_closed", { reason: "fully_spent", channelId: finance.channelId, blockNumber: proof.blockNumber });
        respond(res, 200, { closed: true, reason: "fully_spent", newFundingAuthorized: false, proof }); return;
      }
      if (path === "/api/settle" && req.method === "POST") {
        auth.operator(principal); const body = await jsonBody(req);
        if (body.confirm !== "claim_and_settle_testnet") throw new HttpError(400, "Explicit testnet settlement confirmation required");
        const cfg = await config(), finance = await readFinancial(cfg);
        if (["refunded", "closed"].includes(String(finance.state))) throw new HttpError(409, `Mandate is already ${finance.state}; merchant settlement is not available`);
        if (BigInt(String(finance.spent ?? "0")) === 0n) throw new HttpError(409, "No accepted payment liability exists to claim or settle");
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
        if (Object.keys(body).some(k => !["task","query"].includes(k))) throw new HttpError(400, "Capability fields cannot widen authority");
        const intent = resolveTaskIntent(cfg, body);
        const finance = await readFinancial(cfg);
        if (finance.deposit !== "funded" || finance.state !== "active") throw new HttpError(409, "Confirm Ledger-funded authority before delegating to an agent");
        const authority = intent.spec ?? intent.query;
        const cap = auth.createCapability(configId(cfg), authority, Math.min(Date.parse(cfg.expiresAt), Date.now() + 3600000));
        const file = join(dataDir, `agent-${cap.id}.json`);
        const capability = intent.spec
          ? { version: 2, token: cap.token, broker: origin, task: intent.spec, mandateId: configId(cfg) }
          : { version: 1, token: cap.token, broker: origin, query: intent.query, mandateId: configId(cfg) };
        await writeFile(file, JSON.stringify(capability), { mode: 0o600, flag: "wx" });
        respond(res, 201, { id: cap.id, capabilityFile: relative(root, file), rawTokenReturned: false, task: intent.spec }); return;
      }
      if (path === "/api/evidence/publish" && req.method === "POST") {
        auth.operator(principal); const body = await jsonBody(req);
        if (body.confirm !== "publish_testnet_evidence") throw new HttpError(400, "Confirm the exact testnet evidence batch and its configured fee cap");
        const topic = process.env.MANDATE_HCS_TOPIC_ID, account = process.env.MANDATE_HEDERA_ACCOUNT_ID;
        if (!topic || !account) throw new HttpError(409, "Configure the public HCS topic and publisher account first");
        const cfg = await config();
        const finance = await readFinancial(cfg), merchantEvidence = readMerchantEvidence(typeof finance.channelId === "string" ? finance.channelId : null);
        const plan = await evidencePublicationPlan(finance, merchantEvidence);
        if (plan.plannedRecords === 0) throw new HttpError(409, "There are no pending evidence records to publish");
        if (body.consentHash !== plan.consentHash) throw new HttpError(409, "Evidence queue changed after review; refresh and confirm the new exact batch");
        const taskId = randomUUID();
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
                const available = new Map<string, Journal | undefined>([["workspace",journal],["buyer",financialJournal],["merchant",merchantJournal]]);
                const results: Array<Record<string, unknown>> = [];
                for (const entry of plan.journals) {
                  if (entry.planned === 0) continue;
                  const target = available.get(entry.journal);
                  if (!target) throw new Error(`Reviewed evidence journal ${entry.journal} is no longer available`);
                  const result = await flushOutbox(target,{topic,account,key,limit:entry.planned});
                  results.push({journal:entry.journal,planned:entry.planned,...result});
                  if (result.failed > 0) break;
                }
                return results;
              });
              const confirmedRecords = publications.reduce((sum,p)=>sum+Number(p.confirmed??0),0);
              const failedRecords = publications.reduce((sum,p)=>sum+Number(p.failed??0),0);
              const remainingRecords = journal.pendingCount() + (financialJournal?.pendingCount() ?? 0) + (merchantJournal?.pendingCount() ?? 0);
              const result = {plan,publications,confirmedRecords,failedRecords,remainingRecords,network:"hedera:testnet",topic};
              if(failedRecords>0) {updateTask(taskId,"failed",result,"Publication stopped after the first failed submission; unresolved events remain in durable outboxes");return;}
              updateTask(taskId,"succeeded",result);
            } finally {if(financialJournal && financialJournal!==mandate?.journal)financialJournal.close();merchantJournal?.close();}
          } catch(e) {updateTask(taskId,"failed",{plan},messageOf(e));}
        };
        serial=serial.then(run,run);respond(res,202,{task:taskForApi(taskById(taskId)),plan});return;
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
    await serial; signedWithdrawals.clear(); mandate?.close(); releaseOwner(); journal.close();
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
