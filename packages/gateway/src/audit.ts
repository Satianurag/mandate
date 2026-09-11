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
import {
  Client,
  PrivateKey,
  AccountId,
  TopicId,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";
import type { PolicyDecision, PaymentProposal, SettleResponse } from "./types.ts";

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
  /** Registries read for this verdict, e.g. "6/9". Verdicts under F18
   *  discounting are meaningless without it. */
  coverage: string;
  /** Deployments that failed to answer, for the audit record. */
  chainsFailed: string[];
  /** Present only once the payment actually settled. */
  txId?: string;
  /** SHA-256 of the full decision trace, kept off-topic. */
  traceHash: string;
  /**
   * HCS-14 UAID of the gateway agent that wrote this record. Self-certifying
   * (recomputable from public inputs), so records correlate across protocols
   * without trusting our word for who we are. Absent only when derivation
   * failed — the verdict is load-bearing, the UAID is attribution.
   */
  operatorUaid?: string;
}

export interface HederaOperatorCredentials {
  accountId: string;
  /** Hex-encoded ECDSA private key (with or without 0x prefix). */
  privateKeyHex: string;
}

export interface MandateSummary {
  channelId: string;
  salt: string;
  payer: string;
  receiver: string;
  ceilingBaseUnits: string;
  cumulativeBaseUnits: string;
  calls: number;
  taps: number;
  serviceUrl: string;
}

/**
 * The mandate's audit record: one tap opened a channel, vouchers streamed
 * inside it. Same topic, same shape as payment verdicts — the month-end
 * artifact covers both rails. Coverage is honestly "0/0": mandate opens do
 * not (yet) consult reputation registries; the ceiling is the policy.
 */
export function buildMandateRecord(summary: MandateSummary): AuditRecord {
  const cumulative = Number(summary.cumulativeBaseUnits) / 1e6;
  const ceiling = Number(summary.ceilingBaseUnits) / 1e6;
  return {
    v: 1,
    ts: new Date().toISOString(),
    origin: summary.serviceUrl,
    verdict: "allow",
    reason:
      `mandate stream: ${summary.calls} calls, ${summary.taps} tap(s), ` +
      `$${cumulative.toFixed(2)} of $${ceiling.toFixed(2)} ceiling, channel ${summary.channelId}`,
    amount: cumulative,
    asset: "USDC",
    score: null,
    coverage: "0/0",
    chainsFailed: [],
    traceHash: createHash("sha256")
      .update(
        JSON.stringify({
          channelId: summary.channelId,
          salt: summary.salt,
          payer: summary.payer,
          receiver: summary.receiver,
          taps: summary.taps,
          cumulativeBaseUnits: summary.cumulativeBaseUnits,
        })
      )
      .digest("hex"),
  };
}

export function buildRecord(
  proposal: PaymentProposal,
  decision: PolicyDecision,
  settlement?: SettleResponse,
  operatorUaid?: string
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
    coverage: `${decision.reputation.chainsReachable}/${decision.reputation.chainsQueried}`,
    chainsFailed: [...decision.reputation.chainsFailed],
    txId: settlement?.transaction,
    ...(operatorUaid ? { operatorUaid } : {}),
    traceHash: createHash("sha256")
      .update(JSON.stringify(decision.trace))
      .digest("hex"),
  };
}

/** Legacy record publisher. Durable callers enqueue with Journal before invoking it. */
export async function submit(topicId: string, record: AuditRecord, creds: HederaOperatorCredentials): Promise<void> {
  const { Journal } = await import("./journal.ts");
  const { flushOutbox } = await import("./evidence-publisher.ts");
  const { join } = await import("node:path");
  const journal = new Journal(process.env.MANDATE_AUDIT_JOURNAL ?? join(process.cwd(), "state/audit.sqlite"));
  try {
    const id = journal.event("legacy-audit", null, "audit.record", record);
    const result = await flushOutbox(journal, { topic: topicId, account: creds.accountId,
      key: PrivateKey.fromStringECDSA(creds.privateKeyHex.replace(/^0x/, "")), limit: 100 });
    if (result.failed || !journal.events().some(e => e.id === id && e.anchor_state === "confirmed")) {
      throw new Error("HCS anchor is not confirmed; the durable outbox retains it for retry");
    }
  } finally { journal.close(); }
}
