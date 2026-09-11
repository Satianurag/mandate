/**
 * Wire types: stock `@x402/core` — Mandate never redefines the protocol.
 *
 * `PaymentRequirements`, `PaymentPayload`, `PaymentRequired`, `SettleResponse`,
 * `VerifyResponse` and `SupportedResponse` are re-exported verbatim so every
 * module speaks the exact dialect the SDK parses. Anything below the divider
 * is Mandate's own domain (policy verdicts, reputation) and has no stock
 * equivalent.
 */

export type {
  PaymentRequirements,
  PaymentPayload,
  PaymentRequired,
  SettleResponse,
  VerifyResponse,
  SupportedResponse,
  SupportedKind,
  ResourceInfo,
} from "@x402/core/types";

// ---------------------------------------------------------------------------
// Mandate's own domain types
// ---------------------------------------------------------------------------

import type { PaymentRequirements } from "@x402/core/types";

export type Verdict = "allow" | "step_up" | "deny";

export interface CounterpartyReputation {
  /** ERC-8004 agent id, when the counterparty is a registered agent. */
  agentId?: string;
  /** Resolved from the Agent0 Identity registry index, if present. */
  registered: boolean;
  feedbackCount: number;
  /** Mean of ERC-8004 feedback values, normalised to 0..1. Null when unrated. */
  meanScore: number | null;
  revokedCount: number;
  validationCount: number;
  /** Chains the identity was resolved on, e.g. "base+ethereum". */
  chain?: string;
  /**
   * Registry coverage for this lookup. A chain that failed to answer is a
   * registry we could not read, and an unread registry can only hide NEGATIVE
   * signal -- nobody launders a good reputation. Incomplete coverage therefore
   * has to reach the policy engine rather than being swallowed.
   */
  chainsQueried: number;
  chainsReachable: number;
  /** Names of the deployments that failed, for the audit record. */
  chainsFailed: string[];
}

export interface PaymentProposal {
  requestUrl?: string;
  requestId?: string;
  /** The origin we are about to pay, e.g. "https://data.example.com". */
  origin: string;
  /** Stock v2 requirements, as selected by the x402 client from the 402. */
  requirements: PaymentRequirements;
  /** Amount normalised to a human unit for policy comparison. */
  normalisedAmount: number;
  assetSymbol: string;
}

export interface PolicyDecision {
  verdict: Verdict;
  /** Short, human-readable justification. Written verbatim to the HCS log. */
  reason: string;
  /** Every rule that fired, in evaluation order. Useful for the demo. */
  trace: string[];
  reputation: CounterpartyReputation;
}
