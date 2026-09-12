/** Real first-party testnet tools over stock x402. Providers supply live data, never fixtures. */
import { createServer, type IncomingMessage } from "node:http";
import { HTTPFacilitatorClient, x402ResourceServer, x402HTTPResourceServer, type RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { nodeAdapter } from "./http-adapter.ts";
import { Journal, digest, type StoredResponse } from "./journal.ts";
import { writeStored } from "./paid-handler.ts";
import { EXACT_USDC } from "./agent-exact.ts";
import { CIRCLE_HEDERA_TESTNET_USDC_HTS } from "./facilitators.ts";
import type { AgentToolId } from "./agent-profiles.ts";

export interface PaidAgentProvider {
  id: AgentToolId; description: string; amountBaseUnits: string;
  validate(input: Record<string, unknown>): void;
  execute(input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
}
async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new Error("Use application/json");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > 32768) throw new Error("Tool input exceeds 32 KB"); chunks.push(b); }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Tool input must be an object");
  return body as Record<string, unknown>;
}
export async function createAgentToolService(input: {
  network: "eip155:84532" | "hedera:testnet"; payTo: string; facilitatorUrl: string;
  journal: Journal; providers: PaidAgentProvider[];
}) {
  const core = new x402ResourceServer(new HTTPFacilitatorClient({ url: input.facilitatorUrl }));
  if (input.network === "eip155:84532") core.register(input.network, new ExactEvmScheme());
  else core.register(input.network, new ExactHederaScheme());
  const routes: RoutesConfig = {};
  for (const provider of input.providers) {
    if (!/^[1-9]\d{0,5}$/.test(provider.amountBaseUnits)) throw new Error("Tool price must be a bounded positive base-unit amount");
    routes[`POST /tools/${provider.id}`] = { accepts: { scheme: "exact", network: input.network, payTo: input.payTo,
      price: { asset: input.network === "eip155:84532" ? EXACT_USDC[input.network] : CIRCLE_HEDERA_TESTNET_USDC_HTS, amount: provider.amountBaseUnits,
        ...(input.network === "eip155:84532" ? { extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" } } : {}) }, maxTimeoutSeconds: 120 }, description: provider.description };
  }
  const httpServer = new x402HTTPResourceServer(core, routes); await httpServer.initialize();
  const server = createServer({ maxHeaderSize: 131072 }, (req, res) => { void (async () => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/healthz" && req.method === "GET") { writeStored(res, { status: 200, headers: {}, body: JSON.stringify({ service: "mandate-agent-tools", network: input.network, providers: input.providers.map(p => ({ id: p.id, description: p.description, amountBaseUnits: p.amountBaseUnits })), testnet: true }) }); return; }
    const provider = input.providers.find(p => path === `/tools/${p.id}`);
    if (!provider || req.method !== "POST" || req.url?.includes("?")) { writeStored(res, { status: 404, headers: {}, body: '{"error":"Unknown tool"}' }); return; }
    let body: Record<string, unknown>;
    try { body = await bodyOf(req); provider.validate(body); }
    catch (e) { writeStored(res, { status: 400, headers: {}, body: JSON.stringify({ error: e instanceof Error ? e.message : "Invalid input", paymentProcessingAttempted: false }) }); return; }
    const base = `http://${req.headers.host ?? "127.0.0.1"}`, context = { adapter: nodeAdapter(req, base), path, method: "POST" };
    const intent = digest({ method: "POST", path, body });
    let paymentHash: string | undefined;
    const raw = req.headers["payment-signature"];
    if (typeof raw === "string") { try { paymentHash = digest(decodePaymentSignatureHeader(raw)); } catch { /* SDK returns its challenge */ } }
    if (req.headers["x-mandate-reconcile"] === "1") {
      const saved = paymentHash ? input.journal.merchantReceipt(paymentHash, intent) : null;
      writeStored(res, saved ?? { status: 409, headers: {}, body: '{"error":"No completed receipt; no payment processing attempted"}' }); return;
    }
    if (paymentHash) {
      try { const saved = input.journal.merchantBegin(paymentHash, intent); if (saved) { writeStored(res, saved); return; } }
      catch { writeStored(res, { status: 409, headers: {}, body: '{"error":"Review the existing payment outcome before retrying"}' }); return; }
    }
    const finish = (response: StoredResponse) => { if (paymentHash) input.journal.merchantComplete(paymentHash, response); writeStored(res, response); };
    try {
      const result = await httpServer.processHTTPRequest(context);
      if (result.type === "payment-error") { finish({ status: result.response.status, headers: result.response.headers, body: JSON.stringify(result.response.body) }); return; }
      if (result.type !== "payment-verified" || !paymentHash) { finish({ status: 402, headers: {}, body: '{"error":"Verified x402 payment required"}' }); return; }
      // Exact-only service: a valid payment is verified before invoking the provider.
      // Result is prepared before settlement and is never delivered without settlement.
      const output = await provider.execute(body, AbortSignal.timeout(60000));
      if (Buffer.byteLength(JSON.stringify(output)) > 500000) throw new Error("Provider output exceeds 500 KB");
      input.journal.merchantState(paymentHash, "settling");
      const settled = await httpServer.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, { request: context }, undefined, result.beforeHandlerSettlement);
      if (!settled.success) throw new Error("x402 settlement was not confirmed");
      finish({ status: 200, headers: settled.headers, body: JSON.stringify({ ...output, provider: { owner: "Mandate", service: provider.id, network: input.network }, paid: { transaction: settled.transaction, amountBaseUnits: provider.amountBaseUnits, network: input.network } }) });
    } catch (e) {
      if (paymentHash) input.journal.merchantState(paymentHash, "uncertain", e instanceof Error ? e.message : "Tool failed");
      writeStored(res, { status: 503, headers: {}, body: '{"error":"Tool did not complete. Review the payment outcome before trying again."}' });
    }
  })().catch(() => { if (!res.headersSent) writeStored(res, { status: 503, headers: {}, body: '{"error":"Tool service unavailable"}' }); else res.end(); }); });
  server.requestTimeout = 20000; server.headersTimeout = 10000;
  return server;
}
