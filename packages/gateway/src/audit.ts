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
    coverage: `${decision.reputation.chainsReachable}/${decision.reputation.chainsQueried}`,
    chainsFailed: [...decision.reputation.chainsFailed],
    txId: settlement?.transactionId ?? settlement?.transaction,
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
