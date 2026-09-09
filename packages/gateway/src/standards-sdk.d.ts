/**
 * Type shim for `@hashgraphonline/standards-sdk`.
 *
 * The SDK's runtime is the HCS-14 reference implementation and is proven
 * correct (spec vectors match byte-for-byte — see uaid.test.ts). Its
 * PACKAGING is not: every `.d.ts` re-export is extensionless
 * (`export * from './hcs-14'`), which fails to resolve under
 * `moduleResolution: nodenext` (TS2834, hidden by skipLibCheck), leaving
 * the root module type-empty. Rather than downgrade the project's module
 * resolution for one dependency's bug, this shim declares exactly the
 * surface Mandate uses, copied member-for-member from the SDK's own
 * `.d.ts` files.
 *
 * Drift guard: uaid.test.ts asserts every redeclared enum value and
 * function shape against the real runtime exports. If the SDK renames or
 * renumbers anything, the hermetic suite fails — loudly, not silently.
 */

declare module "@hashgraphonline/standards-sdk" {
  export interface CanonicalAgentData {
    registry: string;
    name: string;
    version: string;
    protocol: string;
    nativeId: string;
    skills: number[];
  }

  export interface DidRoutingParams {
    registry?: string;
    proto?: string;
    nativeId?: string;
    uid?: string;
    domain?: string;
    /** Encoded full source DID when UAID id was sanitized (multibase base58btc, e.g. z...) */
    src?: string;
  }

  export interface ParsedHcs14Did {
    /** SDK's own naming quirk: the did-target reports as 'uaid', not 'did'. */
    method: "aid" | "uaid";
    id: string;
    params: Record<string, string>;
  }

  export function createUaid(existingDid: string, params?: DidRoutingParams): string;
  export function createUaid(
    input: CanonicalAgentData,
    params?: DidRoutingParams,
    options?: { includeParams?: boolean }
  ): Promise<string>;
  export function parseHcs14Did(did: string): ParsedHcs14Did;

  export enum ProfileType {
    PERSONAL = 0,
    AI_AGENT = 1,
    MCP_SERVER = 2,
    FLORA = 3,
  }

  export enum AIAgentType {
    MANUAL = 0,
    AUTONOMOUS = 1,
  }

  /** Subset of the SDK enum: exactly the capabilities Mandate claims. */
  export enum AIAgentCapability {
    KNOWLEDGE_RETRIEVAL = 7,
    TRANSACTION_ANALYTICS = 10,
    SECURITY_MONITORING = 13,
    COMPLIANCE_ANALYSIS = 14,
    FRAUD_DETECTION = 15,
    API_INTEGRATION = 17,
  }

  export interface AIAgentProfile {
    version: string;
    type: ProfileType;
    display_name: string;
    alias?: string;
    bio?: string;
    uaid?: string;
    base_account?: string;
    inboundTopicId?: string;
    outboundTopicId?: string;
    aiAgent: {
      type: AIAgentType;
      capabilities: AIAgentCapability[];
      model: string;
      creator?: string;
    };
  }

  /** Minimal structural typing: Mandate only ever calls `.parse`. */
  export const AIAgentProfileSchema: {
    parse(p: unknown): AIAgentProfile;
  };
}
