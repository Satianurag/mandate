/**
 * The operator's portable identity: HCS-14 UAID + HCS-11 profile.
 *
 * Every HCS audit record carries the UAID of the gateway agent that wrote
 * it, so a finance team (or another agent) can correlate records across
 * protocols without trusting our word for who we are — the AID is
 * self-certifying: anyone recomputes it from six public inputs.
 *
 * Generation and profile-shape validation delegate to the stock
 * `@hashgraphonline/standards-sdk` (the reference implementation). This
 * module holds only Mandate's mapping into it, plus the one spec rule the
 * SDK does not enforce (reserved skills 40-99 — probed, see F25).
 *
 * Spec: https://hol.org/docs/standards/hcs-14/ (Draft)
 */

import {
  createUaid,
  parseHcs14Did,
  AIAgentProfileSchema,
  ProfileType,
  AIAgentType,
  AIAgentCapability,
  type AIAgentProfile,
  type CanonicalAgentData,
} from "@hashgraphonline/standards-sdk";

/** Operator-documented registry namespace for our agent (spec: ERC-8004 alignment). */
export const MANDATE_REGISTRY = "mandate";

/**
 * Agent version in the hashed inputs. Bumping it ROTATES the UAID — that is
 * the spec's change management (any change to the six canonical fields
 * yields a new AID), so bump only when the agent's identity genuinely
 * changes, and link prior/successor via alsoKnownAs when you do.
 */
export const MANDATE_AGENT_VERSION = "0.1.0";

/**
 * HCS-14 core skills claimed for the gateway agent (0-39 taxonomy).
 * Each one must be a true statement about the agent — the hash commits to it:
 * - 13 Security Monitoring: every payment is screened before signing.
 * - 15 Fraud Detection: deny verdicts block spend.
 * - 33 Blockchain Integration: settles on Hedera + EVM rails.
 * - 35 Identity Verification: ERC-8004 counterparty reputation lookup.
 * - 36 Cryptographic Operations: sealed-key signing, device step-up.
 * - 39 Trust Attestation: HCS audit trail attesting every verdict.
 */
export const MANDATE_SKILLS = [13, 15, 33, 35, 36, 39];

const HEDERA_NETWORK_NAMES: Record<string, string> = {
  "hedera:mainnet": "mainnet",
  "hedera:testnet": "testnet",
  "hedera:previewnet": "previewnet",
};

/**
 * The six canonical inputs for the operator agent. The payer account anchors
 * the identity as a CAIP-10 nativeId (`hedera:<network>:<account>`), which is
 * what makes the UAID resolvable back to the key that signs.
 */
export function operatorAgentData(accountId: string, network: string): CanonicalAgentData {
  const net = HEDERA_NETWORK_NAMES[network];
  if (!net) {
    throw new Error(`cannot derive operator UAID: unknown Hedera network ${network}`);
  }
  return {
    registry: MANDATE_REGISTRY,
    name: "Mandate Gateway",
    version: MANDATE_AGENT_VERSION,
    protocol: "rest",
    nativeId: `hedera:${net}:${accountId}`,
    skills: [...MANDATE_SKILLS],
  };
}

/**
 * Spec Implementation Requirement #6: skills must be [0-39] or [100+];
 * 40-99 are reserved and SHALL be rejected. The SDK accepts them (probed),
 * so the wrapper enforces what the reference implementation does not.
 */
export function assertValidSkills(skills: number[]): void {
  for (const s of skills) {
    if (!Number.isInteger(s) || s < 0 || (s >= 40 && s <= 99)) {
      throw new Error(
        `invalid HCS-14 skill ${s}: must be 0-39 (core) or 100+ (OASF); 40-99 are reserved`
      );
    }
  }
}

/**
 * Derive the operator's deterministic UAID. Offline and pure: same inputs,
 * same DID, no network. `uid` carries the account id — the unique handle
 * within the `mandate` registry across operators.
 */
export async function deriveOperatorUaid(accountId: string, network: string): Promise<string> {
  const data = operatorAgentData(accountId, network);
  assertValidSkills(data.skills);
  return createUaid(data, { uid: accountId });
}

/** Parse + validate a UAID string (used to verify mirror read-backs). */
export function parseUaid(did: string): { method: string; id: string; params: Record<string, string | undefined> } {
  const parsed = parseHcs14Did(did);
  return { method: parsed.method, id: parsed.id, params: { ...parsed.params } };
}

/**
 * Build the HCS-11 AI-agent profile for inscription. Pure constructor —
 * the object is validated against the SDK's own zod schema, so the
 * hermetic suite proves the exact bytes we would inscribe, and the live
 * script only transports them.
 *
 * Two honest mappings, documented because they are judgment calls:
 * - agent type AUTONOMOUS: the gateway initiates payments itself within
 *   policy (escalating to a human for step_up), it is not manually driven.
 * - capabilities use the HCS-11 0-18 taxonomy, which predates HCS-14 skills
 *   19-39 — the closest true statements, not a 1:1 copy of MANDATE_SKILLS:
 *   7 Knowledge Retrieval (reputation lookups), 10 Transaction Analytics
 *   (payment-flow screening), 13 Security Monitoring, 14 Compliance
 *   Analysis (policy verdicts), 15 Fraud Detection, 17 API Integration
 *   (the REST proxy). The richer claim lives in the UAID skills.
 * - model is the policy engine, not an LLM — stated literally.
 */
export function buildOperatorProfile(uaid: string, accountId: string): AIAgentProfile {
  return AIAgentProfileSchema.parse({
    version: "1.0",
    type: ProfileType.AI_AGENT,
    display_name: "Mandate Gateway",
    bio: "Hardware-guarded x402 payment agent: policy verdicts over live ERC-8004 reputation, Ledger step-up, HCS audit trail.",
    uaid,
    base_account: accountId,
    aiAgent: {
      type: AIAgentType.AUTONOMOUS,
      capabilities: [
        AIAgentCapability.KNOWLEDGE_RETRIEVAL,
        AIAgentCapability.TRANSACTION_ANALYTICS,
        AIAgentCapability.SECURITY_MONITORING,
        AIAgentCapability.COMPLIANCE_ANALYSIS,
        AIAgentCapability.FRAUD_DETECTION,
        AIAgentCapability.API_INTEGRATION,
      ],
      model: "mandate-policy-engine/0.1.0",
    },
  });
}
