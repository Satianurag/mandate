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
  settlement?: SettleResponse
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
    traceHash: createHash("sha256")
      .update(JSON.stringify(decision.trace))
      .digest("hex"),
  };
}

let queue: Promise<void> = Promise.resolve();

/**
 * Submit to HCS. Never blocks the payment path — callers fire-and-forget,
 * and failures are logged, never thrown. Credentials are REQUIRED and must
 * come from the Key Ring via withSecret: there is deliberately no env-var
 * fallback, per invariant 1 (no plaintext secret in the environment).
 */
export async function submit(
  topicId: string,
  record: AuditRecord,
  creds: HederaOperatorCredentials
): Promise<void> {
  const op = creds;

  queue = queue
    .then(async () => {
      const hex = op.privateKeyHex.startsWith("0x")
        ? op.privateKeyHex.slice(2)
        : op.privateKeyHex;
      const client = Client.forTestnet();
      client.setOperator(
        AccountId.fromString(op.accountId),
        PrivateKey.fromStringECDSA(hex)
      );
      await new TopicMessageSubmitTransaction()
        .setTopicId(TopicId.fromString(topicId))
        .setMessage(JSON.stringify(record))
        .execute(client);
      client.close();
    })
    .catch((err) => {
      console.error("[audit] HCS submit failed (will not block payment):", err);
    });

  await queue;
}
