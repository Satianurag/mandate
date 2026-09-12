/** Exact x402 adapter. No wallet creation, funding or secret decryption at startup. */
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { ClientEvmSigner } from "@x402/evm";
import { createPublicClient, decodeEventLog, getAddress, http, parseAbi, type Hex } from "viem";
import { randomUUID } from "node:crypto";
import { Journal, digest, units, type BudgetLimits } from "./journal.ts";
import { AgentAuthorityError, UncertainAgentPayment, ConfirmedPaidToolFailure, type AgentToolExecutor, type X402Quote, type ToolObservation } from "./agent-runtime.ts";
import type { AgentRun } from "./agent-store.ts";
import type { AgentToolId } from "./agent-profiles.ts";
import { toolById, type AgentToolDefinition, type AgentToolRequest } from "./agent-tools.ts";

export const EXACT_USDC = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
} as const;
export interface ExactAgentAuthority extends BudgetLimits {
  id: string; network: keyof typeof EXACT_USDC; asset: string;
  payerAddress: string; spendingAddress: string; expiresAt: number;
  tools: Array<{ id: AgentToolId; origin: string; pathname: string; payTo: string }>;
}
export function validateExactAuthority(a: ExactAgentAuthority): ExactAgentAuthority {
  if (!a.id || !Object.hasOwn(EXACT_USDC, a.network) || getAddress(a.asset) !== getAddress(EXACT_USDC[a.network])) throw new Error("Unsupported exact x402 network or USDC asset");
  if (!Number.isSafeInteger(a.expiresAt) || a.expiresAt <= Date.now()) throw new Error("Authority must have a future expiry");
  if (units(a.ceilingBaseUnits, true) > 5000000n || units(a.perCallBaseUnits, true) > units(a.ceilingBaseUnits) || units(a.windowBaseUnits, true) > units(a.ceilingBaseUnits) || !Number.isSafeInteger(a.windowMs) || a.windowMs < 1000) throw new Error("Invalid spending limits; this version caps each authority at 5 USDC");
  if (!a.tools.length) throw new Error("Select reviewed x402 endpoints");
  for (const tool of a.tools) {
    const url = new URL(tool.origin);
    const transportAllowed = url.protocol === "https:" || a.network === "eip155:84532" && url.protocol === "http:" && url.hostname === "127.0.0.1";
    if (!transportAllowed || url.origin !== tool.origin || url.username || url.password || !tool.pathname.startsWith("/") || /[?#]/.test(tool.pathname)) throw new Error("Tools must pin HTTPS, or loopback HTTP on testnet, and an exact path");
    getAddress(tool.payTo);
  }
  return structuredClone({ ...a, payerAddress: getAddress(a.payerAddress), spendingAddress: getAddress(a.spendingAddress), asset: getAddress(a.asset) });
}
interface ReviewedQuote { public: X402Quote; request: AgentToolRequest; offer: PaymentRequirements; expiresAt: number }
export interface ExactSettlementInput { transaction: string; payload: PaymentPayload; offer: PaymentRequirements; payer: string }
export type VerifyExactSettlement = (input: ExactSettlementInput) => Promise<void>;
const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)", "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)"]);
export function chainSettlementVerifier(rpcUrl: string, network: keyof typeof EXACT_USDC): VerifyExactSettlement {
  const rpc = createPublicClient({ transport: http(rpcUrl, { timeout: 15000, retryCount: 0 }) });
  return async ({ transaction, payload, offer, payer }) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(transaction)) throw new Error("Settlement transaction hash is invalid");
    if (await rpc.getChainId() !== Number(network.split(":")[1])) throw new Error("Settlement RPC is on another network");
    const receipt = await rpc.getTransactionReceipt({ hash: transaction as Hex });
    if (receipt.status !== "success") throw new Error("Settlement transaction did not succeed");
    const authorization = (payload.payload as { authorization?: { nonce?: string } }).authorization;
    if (!authorization?.nonce) throw new Error("Payment authorization nonce is missing");
    let transfer = false, used = false;
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== getAddress(offer.asset)) continue;
      try {
        const event = decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics });
        if (event.eventName === "Transfer") transfer ||= getAddress(event.args.from) === getAddress(payer) && getAddress(event.args.to) === getAddress(offer.payTo) && event.args.value === BigInt(offer.amount);
        if (event.eventName === "AuthorizationUsed") used ||= getAddress(event.args.authorizer) === getAddress(payer) && event.args.nonce.toLowerCase() === authorization.nonce.toLowerCase();
      } catch { /* unrelated token event */ }
    }
    if (!transfer || !used) throw new Error("Receipt does not prove this exact USDC transfer and authorization nonce");
  };
}
export class ExactAgentExecutor implements AgentToolExecutor {
  readonly authority: ExactAgentAuthority;
  private readonly journal: Journal;
  private readonly tools: AgentToolDefinition[];
  private readonly signer: ClientEvmSigner;
  private readonly verify: VerifyExactSettlement;
  private readonly transport: typeof fetch;
  private readonly quotes = new Map<string, ReviewedQuote>();
  constructor(input: { authority: ExactAgentAuthority; journal: Journal; tools: AgentToolDefinition[]; signer: ClientEvmSigner; verify: VerifyExactSettlement; fetch?: typeof fetch }) {
    this.authority = validateExactAuthority(input.authority); this.journal = input.journal;
    this.tools = input.tools; this.signer = input.signer; this.verify = input.verify; this.transport = input.fetch ?? fetch;
    if (getAddress(this.signer.address) !== this.authority.spendingAddress) throw new Error("Spending signer does not match reviewed authority");
    this.journal.register(this.authority.id, this.authority);
    this.journal.bindIdentity(this.authority.id, this.authority.payerAddress, this.authority.spendingAddress);
  }
  catalog() { return this.tools.filter(t => this.authority.tools.some(a => a.id === t.id)).map(({ id, description, inputSchema }) => ({ id, description, inputSchema })); }
  private assertOffer(toolId: AgentToolId, request: AgentToolRequest, offer: PaymentRequirements): void {
    const url = new URL(request.url), a = this.authority;
    if (Date.now() >= a.expiresAt) throw new AgentAuthorityError("Spending authority expired");
    if (url.username || url.password || url.hash || !a.tools.some(t => t.id === toolId && t.origin === url.origin && t.pathname === url.pathname && getAddress(t.payTo) === getAddress(offer.payTo))) throw new AgentAuthorityError("Endpoint or recipient is outside reviewed authority");
    if (offer.scheme !== "exact" || offer.network !== a.network || getAddress(offer.asset) !== a.asset || (offer.extra?.assetTransferMethod && offer.extra.assetTransferMethod !== "eip3009") || offer.extra?.name !== (a.network === "eip155:8453" ? "USD Coin" : "USDC") || offer.extra?.version !== "2") throw new AgentAuthorityError("Unsupported x402 scheme, asset, network or signing domain");
    if (!Number.isSafeInteger(offer.maxTimeoutSeconds) || offer.maxTimeoutSeconds < 1 || offer.maxTimeoutSeconds > 3600 || Date.now() + offer.maxTimeoutSeconds * 1000 > a.expiresAt) throw new AgentAuthorityError("Payment authorization outlives the spending authority");
    units(offer.amount, true);
  }
  async quote(toolId: AgentToolId, input: Record<string, unknown>, signal: AbortSignal): Promise<X402Quote> {
    const tool = toolById(this.tools, toolId), request = tool.request(input);
    const url = new URL(request.url);
    if (!this.authority.tools.some(t => t.id === toolId && t.origin === url.origin && t.pathname === url.pathname)) throw new AgentAuthorityError("Tool endpoint is not approved");
    const response = await this.transport(request.url, { method: request.method, ...(request.body ? { body: request.body, headers: { "content-type": "application/json" } } : {}), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    const header = response.headers.get("payment-required");
    await response.body?.cancel();
    if (response.status !== 402 || !header) throw new Error(`Tool did not return an x402 payment offer (HTTP ${response.status})`);
    const required = decodePaymentRequiredHeader(header);
    if (required.x402Version !== 2) throw new Error("Only x402 v2 payment offers are supported");
    const offer = required.accepts.find(o => { try { this.assertOffer(toolId, request, o); return true; } catch { return false; } });
    if (!offer) throw new AgentAuthorityError("No offer matches the reviewed endpoint, recipient and signing scope");
    const quote: X402Quote = { toolId, input: structuredClone(input), network: offer.network, asset: offer.asset, amountBaseUnits: offer.amount, offerId: randomUUID() };
    for (const [id, q] of this.quotes) if (q.expiresAt <= Date.now()) this.quotes.delete(id);
    this.quotes.set(quote.offerId, { public: structuredClone(quote), request, offer, expiresAt: Date.now() + 60000 });
    return quote;
  }
  async execute(input: { run: AgentRun; quote: X402Quote; requestId: string; remainingBaseUnits: string; signal: AbortSignal }): Promise<ToolObservation> {
    const { run, quote, requestId, signal } = input, a = this.authority;
    const reviewed = this.quotes.get(quote.offerId);
    if (!reviewed || reviewed.expiresAt <= Date.now() || digest(reviewed.public) !== digest(quote)) throw new AgentAuthorityError("Quote expired or changed; review a fresh offer");
    this.quotes.delete(quote.offerId);
    if (run.authorityId !== a.id || !run.agent.toolIds.includes(quote.toolId) || Date.now() >= run.deadline) throw new AgentAuthorityError("Run is outside its reviewed authority");
    if (this.journal.mandate(a.id)?.deposit !== "funded") throw new AgentAuthorityError("Ledger funding has not been confirmed");
    if (this.journal.requests(a.id).some(r => ["reserved", "signed", "uncertain"].includes(r.state))) throw new AgentAuthorityError("Reconcile the pending payment before spending again");
    this.assertOffer(quote.toolId, reviewed.request, reviewed.offer); signal.throwIfAborted();
    try {
      this.journal.reserve({ id: requestId, mandateId: a.id, digest: digest({ run: run.intentHash, request: reviewed.request, offer: reviewed.offer }), network: a.network, asset: a.asset, amount: quote.amountBaseUnits, limits: a,
        group: { id: run.id, ceilingBaseUnits: run.agent.budgetBaseUnits, perCallBaseUnits: run.agent.perCallBaseUnits } });
    } catch (e) { throw new AgentAuthorityError(e instanceof Error ? e.message : "Spending reservation rejected"); }
    let signingAttempted = false;
    try {
      const signer: ClientEvmSigner = { address: this.signer.address, signTypedData: async params => {
        signal.throwIfAborted(); this.journal.assertActive(a.id); this.assertOffer(quote.toolId, reviewed.request, reviewed.offer);
        const m = params.message as Record<string, unknown>, d = params.domain;
        if (params.primaryType !== "TransferWithAuthorization" || Number(d.chainId) !== Number(a.network.split(":")[1]) || getAddress(String(d.verifyingContract)) !== a.asset || getAddress(String(m.from)) !== a.spendingAddress || getAddress(String(m.to)) !== getAddress(reviewed.offer.payTo) || BigInt(String(m.value)) !== BigInt(quote.amountBaseUnits) || BigInt(String(m.validBefore)) * 1000n > BigInt(a.expiresAt)) throw new AgentAuthorityError("Signer was asked to authorize different payment terms");
        // Record uncertainty BEFORE crossing into an asynchronous signer.
        this.journal.signed(requestId, { signingAttempt: params }); signingAttempted = true;
        return this.signer.signTypedData(params);
      } };
      const client = new x402Client(); client.register(a.network, new ExactEvmScheme(signer));
      const payload = await client.createPaymentPayload({ x402Version: 2, resource: { url: reviewed.request.url }, accepts: [reviewed.offer] });
      this.journal.signed(requestId, payload);
      signal.throwIfAborted(); this.journal.assertActive(a.id);
      const headers = { "payment-signature": encodePaymentSignatureHeader(payload), ...(reviewed.request.body ? { "content-type": "application/json" } : {}) };
      const response = await this.transport(reviewed.request.url, { method: reviewed.request.method, headers, body: reviewed.request.body, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
      const settlementHeader = response.headers.get("payment-response");
      if (!settlementHeader) throw new UncertainAgentPayment(`Paid endpoint omitted a settlement receipt (HTTP ${response.status})`);
      const settlement = decodePaymentResponseHeader(settlementHeader);
      if (!settlement.success || settlement.network !== a.network || !settlement.transaction) throw new UncertainAgentPayment("Payment settlement is not confirmed");
      await this.verify({ transaction: settlement.transaction, payload, offer: reviewed.offer, payer: a.spendingAddress });
      this.journal.accept(requestId, quote.amountBaseUnits, { ...settlement, chainVerified: true });
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (reader) for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 512000) { await reader.cancel(); throw new Error("Paid response exceeded the 512 KB evidence limit"); } chunks.push(chunk.value); }
      const text = Buffer.concat(chunks).toString("utf8");
      this.journal.saveResponse(requestId, { status: response.status, headers: { "payment-response": settlementHeader }, body: text });
      if (!response.ok) throw new Error(`Payment confirmed but service returned HTTP ${response.status}`);
      const data = JSON.parse(text) as unknown;
      if (data && typeof data === "object" && ("errors" in data || "error" in data && Boolean(data.error))) throw new Error("Payment confirmed but service returned an error payload");
      const tool = toolById(this.tools, quote.toolId), sources = tool.sources(data);
      if (!sources.some(s => s.url === reviewed.request.url)) sources.push({ url: reviewed.request.url, title: `${quote.toolId} · paid source` });
      return { toolId: quote.toolId, requestId, data, sources, receipt: { network: a.network, asset: a.asset, amountBaseUnits: quote.amountBaseUnits, transaction: settlement.transaction } };
    } catch (e) {
      const record = this.journal.request(requestId);
      if (record?.state === "accepted" && record.receipt) {
        const receipt = JSON.parse(record.receipt) as { transaction: string };
        throw new ConfirmedPaidToolFailure({ toolId: quote.toolId, requestId, data: null, sources: [{ url: reviewed.request.url, title: `${quote.toolId} · paid service` }],
          receipt: { network: a.network, asset: a.asset, amountBaseUnits: record.charged!, transaction: receipt.transaction },
          error: e instanceof Error ? e.message : "The paid service did not return usable evidence" });
      }
      this.journal.fail(requestId, e instanceof Error ? e.message : "Payment failed");
      if (!signingAttempted) throw new AgentAuthorityError(e instanceof Error ? e.message : "Payment blocked before signing");
      throw new UncertainAgentPayment(e instanceof Error ? e.message : "Payment needs review");
    }
  }
}
