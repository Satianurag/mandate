/** Shared merchant ordering: prepare -> stock verification/settlement -> persist -> respond. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { x402HTTPResourceServer } from "@x402/core/server";
import { nodeAdapter } from "./http-adapter.ts";
import { Journal, digest, type StoredResponse } from "./journal.ts";
import { validateAnalyticsQuery } from "./query-scope.ts";
import { AGENT0_SAMPLE_QUERY } from "./analytics.ts";
import { validateResearchSource, type ResearchSourceScope } from "./research-task.ts";

export function writeStored(res: ServerResponse, response: StoredResponse): void {
  res.writeHead(response.status, { "content-type": "application/json", "cache-control": "private, no-store", ...response.headers });
  res.end(response.body);
}
export async function handlePaidRequest(opts: {
  req: IncomingMessage; res: ServerResponse; httpServer: x402HTTPResourceServer; journal: Journal;
  prepare: (request: { query: string; source?: ResearchSourceScope }) => Promise<Record<string, unknown>>;
  actualAmount?: (path: string) => string | undefined;
}): Promise<void> {
  const { req, res, httpServer, journal } = opts;
  const base = `http://${req.headers.host ?? "localhost"}`;
  let url: URL, path: string, query: string, source: ResearchSourceScope | undefined;
  try {
    url = new URL(req.url ?? "/", base);
    path = url.pathname;
    const allowed = new Set(["q", "sourceChain", "sourceDeployment"]);
    if ([...url.searchParams.keys()].some(key => !allowed.has(key))) throw new Error("Paid analytics request contains unsupported query parameters");
    if (url.searchParams.getAll("q").length > 1 || url.searchParams.getAll("sourceChain").length > 1 || url.searchParams.getAll("sourceDeployment").length > 1) {
      throw new Error("Paid analytics request contains duplicate query parameters");
    }
    query = url.searchParams.get("q") ?? AGENT0_SAMPLE_QUERY;
    const sourceChain = url.searchParams.get("sourceChain"), sourceDeployment = url.searchParams.get("sourceDeployment");
    if ((sourceChain === null) !== (sourceDeployment === null)) throw new Error("Research source chain and deployment must be supplied together");
    source = sourceChain && sourceDeployment ? validateResearchSource({ provider: "the-graph", chain: sourceChain, deployment: sourceDeployment }) : undefined;
  } catch (e) {
    writeStored(res, { status: 400, headers: {}, body: JSON.stringify({
      error: e instanceof Error ? e.message : String(e),
      paymentCommitted: false,
      paymentProcessingAttempted: false,
    }) });
    return;
  }
  const adapter = nodeAdapter(req, base);
  const context = { adapter, path, method: req.method ?? "GET" };
  const raw = req.headers["payment-signature"] ?? req.headers["x-payment"];
  let paymentHash: string | undefined;
  let recovery = false;
  let prepared: Record<string, unknown> | undefined;
  let settlementHeaders: Record<string, string> = {};
  const finish = (response: StoredResponse) => {
    if (paymentHash) journal.merchantComplete(paymentHash, response);
    writeStored(res, response);
  };
  try {
    if (typeof raw === "string" && raw.length <= 131072) {
      try {
        const payload = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          paymentHash = digest(payload);
          recovery = payload.payload?.type === "refund";
        }
      } catch { /* Let the stock parser issue its normal malformed-payment challenge. */ }
    }
    if (req.headers["x-mandate-reconcile"] === "1") {
      // Receipt retrieval NEVER invokes payment processing, Graph, or settlement.
      const cached = paymentHash ? journal.merchantReceipt(paymentHash, digest({method:context.method,path:url.pathname,search:url.search})) : null;
      if (cached) writeStored(res,{...cached,headers:{...cached.headers,"x-mandate-reconciled":"true"}});
      else writeStored(res,{status:409,headers:{},body:JSON.stringify({error:"No completed receipt is available; liability remains unresolved",paymentProcessingAttempted:false})});
      return;
    }
    if (paymentHash) {
      try {
        const cached = journal.merchantBegin(paymentHash, digest({ method: context.method, path: url.pathname, search: url.search }));
        if (cached) { writeStored(res, cached); return; }
      } catch (e) {
        writeStored(res, { status: 409, headers: {}, body: JSON.stringify({ error: e instanceof Error ? e.message : String(e), reconciliationRequired: true }) });
        return;
      }
      journal.event("merchant", paymentHash, "merchant.request_received", { method: context.method, path, query, source: source ?? null, recovery });
      if (!recovery && httpServer.requiresPayment(context)) {
        try { validateAnalyticsQuery(query); }
        catch (e) {
          finish({ status: 400, headers: {}, body: JSON.stringify({ error: e instanceof Error ? e.message : String(e), paymentCommitted: false }) }); return;
        }
        try {
          // Deliberately before processHTTPRequest: some stock flows settle deposits upfront.
          prepared = await opts.prepare({ query, source });
          if (Buffer.byteLength(JSON.stringify(prepared)) > 1_000_000) throw new Error("Analytics result exceeds the 1 MB response bound");
        } catch (e) {
          journal.event("merchant", paymentHash, "merchant.prepare_failed", { message: e instanceof Error ? e.message : String(e), paymentCommitted: false });
          finish({ status: 503, headers: {}, body: JSON.stringify({ error: e instanceof Error ? e.message : String(e), paymentCommitted: false }) }); return;
        }
      }
      journal.merchantState(paymentHash, "settling");
    }
    const out = await httpServer.processHTTPRequest(context);
    if (out.type === "no-payment-required") { finish({ status: 404, headers: {}, body: '{"error":"Unknown paid resource"}' }); return; }
    if (out.type === "payment-error") {
      // Includes stock refund skip-handler responses; do not strip their receipt headers.
      finish({ status: out.response.status, headers: out.response.headers, body: JSON.stringify(out.response.body) }); return;
    }
    if (!prepared) throw new Error("No prepared result exists; refusing to commit payment");
    const amount = opts.actualAmount?.(path);
    const settled = await httpServer.processSettlement(out.paymentPayload, out.paymentRequirements,
      out.declaredExtensions, { request: context }, amount ? { amount } : undefined,
      out.beforeHandlerSettlement);
    settlementHeaders = settled.headers ?? {};
    if (!settled.success) {
      if (paymentHash) journal.event("merchant", paymentHash, "merchant.settlement_failed", { reason: settled.errorReason, headers: settlementHeaders });
      finish({ status: 402, headers: settlementHeaders, body: JSON.stringify({ error: settled.errorReason, reconciliationRequired: true }) }); return;
    }
    const scheme = out.paymentRequirements.scheme;
    const body = { ...prepared, paid: {
      amount: amount ?? out.paymentRequirements.amount,
      amountBaseUnits: amount ?? out.paymentRequirements.amount,
      asset: out.paymentRequirements.asset, network: out.paymentRequirements.network,
      scheme, txId: settled.transaction || null, txHash: settled.transaction || null,
      stage: scheme === "batch-settlement" ? "voucher_accepted" : "settlement_reported",
    } };
    if (paymentHash) journal.event("merchant", paymentHash, "merchant.payment_accepted", { requirements: out.paymentRequirements, receipt: settled, stage: body.paid.stage });
    // Store the complete original result and receipt before touching the socket.
    finish({ status: 200, headers: settlementHeaders, body: JSON.stringify(body) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (paymentHash) {
      journal.merchantState(paymentHash, "uncertain", message);
      journal.event("merchant", paymentHash, "merchant.outcome_uncertain", { message });
    }
    writeStored(res, { status: 503, headers: settlementHeaders, body: JSON.stringify({ error: message, reconciliationRequired: Boolean(paymentHash) }) });
  }
}
