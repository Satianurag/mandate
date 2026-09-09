/**
 * Wire types for the x402 `exact` scheme on Hedera.
 *
 * Source of truth:
 *   https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md
 *
 * The Hedera scheme is client-driven: the client builds and PARTIALLY signs a
 * TransferTransaction, and the facilitator -- named as `feePayer` in
 * `extra` -- completes it and pays the network fee. That split is what lets
 * Mandate keep the signing key sealed until the last possible moment.
 */

/** CAIP-2 network identifier, e.g. "hedera:testnet" | "hedera:mainnet". */
export type HederaNetwork = `hedera:${string}`;

export interface HederaExtra {
  /** Hedera account ID that sponsors network fees. Usually the facilitator. */
  feePayer: string;
  /** Extra facilitator fields pass through untouched (x402 `extra` is open). */
  [key: string]: unknown;
}

export interface PaymentRequirements {
  scheme: "exact";
  network: HederaNetwork;
  /** Entity ID of the asset. "0.0.0" denotes native HBAR. */
  asset: string;
  /**
   * Amount in the asset's smallest unit.
   * HBAR is expressed in TINYBARS (1 HBAR = 1e8 tinybars); HTS tokens use the
   * token's configured decimals. Off-by-one-decimal is the single most common
   * integration failure here -- see docs/threat-model.md.
   */
  amount: string;
  /** Hedera account ID credited by the payment. */
  payTo: string;
  maxTimeoutSeconds: number;
  resource?: string;
  description?: string;
  extra: HederaExtra;
}

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

/**
 * PaymentPayload (x402 v2).
 *
 * `@x402/hedera` facilitator verify requires `accepted` to mirror
 * `paymentRequirements` — see ExactHederaScheme.validateRequirements().
 */
export interface PaymentPayload {
  x402Version: 1 | 2;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: {
    /** Base64-encoded, partially-signed Hedera TransferTransaction. */
    transaction: string;
  };
}

export interface SettlementResponse {
  success: boolean;
  /** Hedera transaction ID, e.g. "0.0.1234@1757280000.000000000". */
  transactionId?: string;
  /** Blocky402 returns `transaction` instead of `transactionId`. */
  transaction?: string;
  network?: HederaNetwork;
  payer?: string;
  errorReason?: string;
}

/** The 402 body a resource server returns when payment is required. */
export interface PaymentRequiredBody {
  x402Version: number;
  accepts: PaymentRequirements[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Mandate's own domain types
// ---------------------------------------------------------------------------

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
  /** The origin we are about to pay, e.g. "https://data.example.com". */
  origin: string;
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
