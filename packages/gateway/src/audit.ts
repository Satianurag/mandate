/**
 * The audit trail is the product.
 *
 * Every verdict -- allow, step_up, deny -- is submitted to a Hedera Consensus
 * Service topic. Consensus timestamps give an ordering that no application
 * level log can forge or backdate, which is what makes this the artifact a
 * finance team actually wants at the end of the month.
 *
 * The record is deliberately small: HCS messages are capped, and a payment
 * decision does not need a blob. Anything large (the full policy trace, the
 * raw subgraph response) is hashed here and kept off-topic.
 */

import { createHash } from "node:crypto";
import type { PolicyDecision, PaymentProposal, SettlementResponse } from "./types.ts";

export interface AuditRecord {
  v: 1;
  ts: string;
  origin: string;
  verdict: PolicyDecision["verdict"];
  reason: string;
  amount: number;
  asset: string;
  /** ERC-8004 identity of the counterparty, when one resolved. */
  agentId?: string;
  score: number | null;
  /** Present only once the payment actually settled. */
  txId?: string;
  /** SHA-256 of the full decision trace, kept off-topic. */
  traceHash: string;
}

export function buildRecord(
  proposal: PaymentProposal,
  decision: PolicyDecision,
  settlement?: SettlementResponse
): AuditRecord {
  return {
    v: 1,
    ts: new Date().toISOString(),
    origin: proposal.origin,
    verdict: decision.verdict,
    reason: decision.reason,
    amount: proposal.normalisedAmount,
    asset: proposal.assetSymbol,
    agentId: decision.reputation.agentId,
    score: decision.reputation.meanScore,
    txId: settlement?.transactionId,
    traceHash: createHash("sha256")
      .update(JSON.stringify(decision.trace))
      .digest("hex"),
  };
}

/**
 * TODO(day-2): submit via @hiero-ledger/sdk.
 *
 *   await new TopicMessageSubmitTransaction()
 *     .setTopicId(topicId)
 *     .setMessage(JSON.stringify(record))
 *     .execute(client);
 *
 * Submission must never block the payment path -- a consensus write that is
 * slow or failing should be queued and retried, not turned into a refusal.
 * The log records what happened; it does not decide what happens.
 */
export async function submit(_topicId: string, _record: AuditRecord): Promise<void> {
  throw new Error("audit.submit: not yet implemented -- see Day 2 in docs/plan.md");
}
