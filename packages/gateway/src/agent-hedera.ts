/** Native Hedera exact-x402 payments share the agent's USDC budget, not an EVM bridge. */
import { inspectHederaTransaction, type ClientHederaSigner } from "@x402/hedera";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
export const AGENT_HEDERA_USDC = "0.0.429274";
export interface AgentHederaScope {
  accountId: string; payTo: string; feePayer: string; endpoint: string;
}
const entity = /^0\.0\.[1-9][0-9]{0,14}$/;
export function validateHederaScope(scope: AgentHederaScope): AgentHederaScope {
  for (const id of [scope.accountId, scope.payTo, scope.feePayer]) if (!entity.test(id)) throw new Error("Hedera authority requires explicit numeric testnet account IDs");
  if (scope.accountId === scope.payTo || scope.accountId === scope.feePayer) throw new Error("Hedera payer must differ from service recipient and facilitator fee payer");
  const url = new URL(scope.endpoint);
  if (!(url.protocol === "https:" || url.protocol === "http:" && url.hostname === "127.0.0.1") || url.username || url.password || url.search || url.hash || url.pathname !== "/tools/hedera-analysis") throw new Error("Hedera analysis must use the reviewed first-party testnet endpoint");
  return structuredClone(scope);
}
export function assertHederaOffer(scope: AgentHederaScope, offer: PaymentRequirements): void {
  if (offer.scheme !== "exact" || offer.network !== "hedera:testnet" || offer.asset !== AGENT_HEDERA_USDC || offer.payTo !== scope.payTo || offer.extra?.feePayer !== scope.feePayer) throw new Error("Hedera offer changed the approved network, asset, recipient or fee payer");
}
export function transactionIdForMirror(value: string): string {
  const match = /^(0\.0\.\d{1,15})[-@](\d{1,12})[-.](\d{1,9})$/.exec(value);
  if (!match) throw new Error("Invalid Hedera transaction ID");
  return `${match[1]}-${match[2]}-${match[3]!.padStart(9, "0")}`;
}
export function assertHederaPayload(scope: AgentHederaScope, offer: PaymentRequirements, transaction: string): string {
  assertHederaOffer(scope, offer);
  const inspected = inspectHederaTransaction(transaction);
  if (inspected.hasNonTransferOperations || inspected.transactionIdAccountId !== scope.feePayer || inspected.hbarTransfers.some(t => BigInt(t.amount) !== 0n)) throw new Error("Hedera transaction contains an unapproved operation or HBAR debit");
  const tokens = Object.entries(inspected.tokenTransfers);
  if (tokens.length !== 1 || tokens[0]![0] !== AGENT_HEDERA_USDC) throw new Error("Hedera transaction changed the token");
  const transfers = tokens[0]![1];
  if (transfers.length !== 2 || !transfers.some(t => t.accountId === scope.accountId && BigInt(t.amount) === -BigInt(offer.amount)) || !transfers.some(t => t.accountId === scope.payTo && BigInt(t.amount) === BigInt(offer.amount))) throw new Error("Hedera transaction changed the exact payer, recipient or amount");
  return transactionIdForMirror(inspected.transactionId);
}
export type VerifyHederaAgentSettlement = (input: { transaction: string; payload: PaymentPayload; offer: PaymentRequirements; scope: AgentHederaScope }) => Promise<void>;
export function hederaSettlementVerifier(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): VerifyHederaAgentSettlement {
  const transport = options.fetch ?? fetch;
  return async ({ transaction, payload, offer, scope }) => {
    const bytes = (payload.payload as { transaction?: string }).transaction;
    if (!bytes) throw new Error("Hedera receipt has no retained signed transaction");
    const expected = assertHederaPayload(scope, offer, bytes);
    if (transactionIdForMirror(transaction) !== expected) throw new Error("Hedera settlement ID does not match the signed transaction");
    const until = Date.now() + (options.timeoutMs ?? 45000);
    while (Date.now() < until) {
      const response = await transport(`https://testnet.mirrornode.hedera.com/api/v1/transactions/${expected}`, { redirect: "error", signal: AbortSignal.timeout(10000) });
      if (response.ok) {
        const body = await response.json() as { transactions?: Array<{ transaction_id?: string; result?: string; token_transfers?: Array<{ token_id: string; account: string; amount: number | string }> }> };
        const settled = body.transactions?.find(row => row.transaction_id === expected && row.result === "SUCCESS");
        if (settled) {
          const transfers = settled.token_transfers ?? [];
          if (transfers.length !== 2 || transfers.some(t => t.token_id !== AGENT_HEDERA_USDC) || !transfers.some(t => t.account === scope.accountId && BigInt(t.amount) === -BigInt(offer.amount)) || !transfers.some(t => t.account === scope.payTo && BigInt(t.amount) === BigInt(offer.amount))) throw new Error("Mirror receipt does not prove the exact reviewed USDC transfer");
          return;
        }
        if (body.transactions?.some(row => row.result && row.result !== "SUCCESS" && row.result !== "DUPLICATE_TRANSACTION")) throw new Error("Hedera mirror reports a failed settlement");
      } else if (response.status !== 404 && response.status !== 429) throw new Error(`Hedera receipt lookup failed (HTTP ${response.status})`);
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
    throw new Error("Hedera mirror receipt is not yet available; retain the reservation and reconcile");
  };
}
export interface AgentHederaPaymentServices { signer: ClientHederaSigner; verify: VerifyHederaAgentSettlement }
