import { assertTestnetNetwork } from "./testnet.ts";
/**
 * Mandate's x402 client: stock payment flow, Mandate judgment.
 *
 * The payment mechanics are entirely stock -- `x402Client` + the Hedera
 * `exact` scheme (and, for Graph/upto, stock `ExactEvmScheme` via
 * `createMandateEvmClient`) + `wrapFetchWithPayment` handle the 402,
 * payload assembly, signing, header encoding, retry, and settlement
 * parsing. Mandate plugs in at the two hook points the SDK provides:
 *
 * - `onBeforePaymentCreation` runs `decide()`: reputation lookup, policy
 *   evaluation, device step-up. A deny aborts creation (no key is ever
 *   unsealed, no signature exists) and the proxy maps it to a 403.
 * - `onPaymentResponse` accrues the window budget (only when the server's
 *   settlement actually succeeded) and writes the audit record to HCS.
 *
 * Fail-safe runs through both hooks: anything the client cannot judge --
 * unreachable reputation, an unparseable amount, a denied step-up -- becomes
 * a deny, never an allow and never a silent pass-through.
 */

import { x402Client } from "@x402/core/client";
import {
  ExactHederaScheme,
  HBAR_ASSET_ID,
  type ClientHederaSigner,
} from "@x402/hedera";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { PolicyEngine, DEFAULT_POLICY } from "./policy.ts";
import { Journal, digest, units, type BudgetLimits } from "./journal.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { lookupCounterparty, AGENT0_SUBGRAPHS } from "./reputation.ts";
import { CIRCLE_HEDERA_TESTNET_USDC_HTS } from "./facilitators.ts";
import { normaliseAmount, createSealedHederaSigner } from "./hedera.ts";
import { buildRecord, submit } from "./audit.ts";
import { deriveOperatorUaid } from "./uaid.ts";
import type { SettleResponse } from "./types.ts";
import { requireDeviceApproval, StepUpDenied, type StepUpDeps } from "./stepup.ts";
import { withSecret } from "./keyring.ts";
import { assertFreshPresence, type PresenceAttestation } from "./presence.ts";
import { createEvmX402Client } from "./evm-client.ts";
import type { ClientEvmSigner } from "@x402/evm";
import type {
  CounterpartyReputation,
  PaymentProposal,
  PolicyDecision,
} from "./types.ts";

export interface PresenceGate {
  attestation: PresenceAttestation | null;
  operator: `0x${string}`;
  uaid: string;
}

/** A reputation record that says "we could not read any registry", honestly. */
function unavailableReputation(failure: string): CounterpartyReputation {
  return {
    registered: false,
    feedbackCount: 0,
    meanScore: null,
    revokedCount: 0,
    validationCount: 0,
    chainsQueried: Object.keys(AGENT0_SUBGRAPHS).length,
    chainsReachable: 0,
    chainsFailed: [failure],
  };
}

/**
 * Judge one payment: reputation, policy, step-up.
 *
 * @param origin       Payee origin, for policy messages and the audit record.
 * @param requirements The requirements the stock client selected from the 402.
 * @param graphApiKey  Sealed Graph key, or null when this host has none --
 *                     reputation is then UNAVAILABLE, never trusted.
 */
export async function decide(
  origin: string,
  requirements: PaymentRequirements,
  graphApiKey: string | null,
  deps: { stepUp?: StepUpDeps; presence?: PresenceGate; requestId?: string } = {}
): Promise<{ proposal: PaymentProposal; decision: PolicyDecision }> {
  let proposal: PaymentProposal;
  try {
    const { amount, symbol } = normaliseAmount(requirements);
    proposal = { origin: new URL(origin).origin, requestUrl: origin, requestId: deps.requestId, requirements, normalisedAmount: amount, assetSymbol: symbol };
  } catch (e) {
    // An amount we cannot parse is a payment we cannot judge, and a payment
    // we cannot judge is a payment we do not make. Deny (audited below by
    // the caller) instead of throwing a 500 that hides the reason.
    const reputation = unavailableReputation("amount-unparseable");
    return {
      proposal: {
        origin,
        requirements,
        normalisedAmount: NaN,
        assetSymbol: requirements.asset,
      },
      decision: {
        verdict: "deny",
        reason: e instanceof Error ? e.message : String(e),
        trace: ["amount:unparseable"],
        reputation,
      },
    };
  }

  // A null key means reputation is UNAVAILABLE (no sealed key on this host),
  // not "unregistered". No doomed lookups are attempted; the coverage record
  // says exactly what happened, and policy degrades to step_up.
  const reputation =
    graphApiKey === null
      ? unavailableReputation("graph-key-missing")
      : await lookupCounterparty(requirements.payTo, graphApiKey, {
          network: requirements.network,
        }).catch((e) => {
          // Total lookup failure (programming error, not a registry outage --
          // those are recorded per-chain inside the reputation record). Fail
          // safe AND say so: zero registries were read.
          console.error(
            `[reputation] lookup failed: ${e instanceof Error ? e.message : e}`
          );
          return unavailableReputation("lookup-failed");
        });

  let decision = new PolicyEngine(DEFAULT_POLICY).evaluate(proposal, reputation);
  // Raw, heterogeneous reputation is advisory; it never creates spending authority.
  if (decision.verdict === "allow") decision = { ...decision, verdict: "step_up",
    reason: "Reputation is advisory. This legacy payment requires an explicit, action-bound operator approval.",
    trace: [...decision.trace, "authority:explicit-approval-required"] };

  if (deps.presence && decision.verdict !== "deny") {
    try {
      await assertFreshPresence(deps.presence.attestation, {
        operator: deps.presence.operator,
        uaid: deps.presence.uaid,
      });
    } catch (e) {
      return {
        proposal,
        decision: {
          ...decision,
          verdict: "deny",
          reason: e instanceof Error ? e.message : String(e),
          trace: [...decision.trace, "poh:missing-or-stale"],
        },
      };
    }
  }

  if (decision.verdict === "step_up") {
    try {
      await requireDeviceApproval(
        {
          proposal,
          reason: decision.reason,
          timeoutMs: Number(process.env.MANDATE_STEPUP_TIMEOUT_MS ?? 120_000),
        },
        deps.stepUp ?? {}
      );
    } catch (e) {
      if (e instanceof StepUpDenied) {
        return {
          proposal,
          decision: { ...decision, verdict: "deny" as const, reason: e.message },
        };
      }
      throw e;
    }
  }

  return { proposal, decision };
}

/** Derive the payee origin from the 402's resource URL. Never throws. */
function originOf(paymentRequired: PaymentRequired): string {
  const url = paymentRequired.resource?.url;
  if (!url) return "unknown-origin";
  try {
    return new URL(url).toString();
  } catch {
    return "unknown-origin";
  }
}

export interface MandateClientOpts {
  /** Caller-pinned resource; remote challenge metadata cannot choose another action. */
  resourceUrl?: string;
  journal?: Journal;
  budgetLimits?: BudgetLimits;
  /** Sealed Hedera key ciphertext. Unsealed only inside a signing call. */
  hederaCiphertext: Buffer;
  /** Payer account id (the sealed key's account). */
  accountId: string;
  /** Sealed Graph key, or null when this host has none. */
  graphApiKey: string | null;
  /** HCS topic for audit records. Unset skips submission (tests). */
  hcsTopic?: string;
  /** Step-up device injection (tests approve/deny programmatically). */
  stepUp?: StepUpDeps;
  /** When set, first allow requires a fresh Proof of You attestation (F33). */
  presence?: PresenceGate;
  /**
   * Signer override. Production omits this and gets the sealed signer;
   * hermetic tests inject an ephemeral-key stock signer so the full
   * pay→settle loop runs without the Key Ring or the network (same DI
   * pattern as the step-up device).
   */
  signer?: ClientHederaSigner;
}

export interface MandateEvmClientOpts extends MandateClientOpts {
  evmSigner: ClientEvmSigner;
  rpcUrl: string;
  chainId?: number;
}

export interface MandateClient {
  close: () => void;
  x402: x402Client;
  /**
   * The last judgment made by the before-hook, if any. The proxy uses it to
   * map an aborted payment to a 403 with the real reason -- without parsing
   * SDK error strings.
   */
  getLastDecision: () => { proposal: PaymentProposal; decision: PolicyDecision } | undefined;
}

export function attachMandateHooks(client: x402Client, opts: MandateClientOpts): MandateClient {
  type Judgment = { proposal: PaymentProposal; decision: PolicyDecision };
  type Pending = { id: string; mandateId: string; judgment: Judgment };
  const journal = opts.journal ?? new Journal(process.env.MANDATE_JOURNAL_PATH ?? join(process.cwd(), "state/gateway.sqlite"));
  let last: Judgment | undefined;
  let closed = false;
  const contexts = new WeakMap<PaymentRequired, Pending>();
  const payloads = new Map<string, Pending>();
  const audit = async (p: Pending, settlement?: SettleResponse) => {
    const { proposal, decision } = p.judgment;
    journal.event(p.mandateId, p.id, "policy.decision", { proposal, decision, settlement: settlement ?? null });
    // Durable local events are authoritative for publication scheduling. No fire-and-forget HCS promise.
  };
  client.onBeforePaymentCreation(async ctx => {
    if (closed) return { abort: true, reason: "Payment client is closed" };
    if (!opts.resourceUrl) return { abort: true, reason: "An explicit resourceUrl is required; untrusted challenge URLs cannot authorize payments" };
    if (contexts.has(ctx.paymentRequired)) return { abort: true, reason: "Concurrent reuse of one payment challenge is forbidden" };
    const resource = new URL(opts.resourceUrl);
    const offered = new URL(originOf(ctx.paymentRequired));
    if (resource.origin !== offered.origin || resource.pathname !== offered.pathname || resource.search !== offered.search) {
      return { abort: true, reason: "Payment challenge does not match the requested resource" };
    }
    const r = ctx.selectedRequirements, id = randomUUID();
    const mandateId = digest({ kind: "legacy-explicit-approval", payer: opts.accountId, network: r.network, asset: r.asset.toLowerCase() });
    let reserved = false;
    try {
      assertTestnetNetwork(r.network);
      units(r.amount, true);
      const { amount, symbol } = normaliseAmount(r);
      const scale = symbol === "HBAR" ? 100_000_000n : 1_000_000n;
      const limits: BudgetLimits = opts.budgetLimits ?? {
        ceilingBaseUnits: String(2n ** 256n - 1n),
        perCallBaseUnits: String(5n * scale), windowBaseUnits: String(5n * scale), windowMs: DEFAULT_POLICY.windowMs,
      };
      journal.register(mandateId, { network: r.network, asset: r.asset.toLowerCase(), payer: opts.accountId, limits });
      journal.reserve({ id, mandateId, digest: digest({ resource: resource.toString(), requirements: r }), network: r.network, asset: r.asset, amount: r.amount, limits });
      reserved = true;
      const judgment = await decide(resource.toString(), r, opts.graphApiKey, {
        stepUp: { ...opts.stepUp, journal: opts.stepUp?.journal ?? journal }, presence: opts.presence, requestId: id,
      });
      last = judgment;
      const pending = { id, mandateId, judgment };
      if (judgment.decision.verdict === "deny") {
        journal.fail(id, judgment.decision.reason); await audit(pending);
        return { abort: true, reason: judgment.decision.reason };
      }
      contexts.set(ctx.paymentRequired, pending);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (reserved) journal.fail(id, reason);
      const reputation = unavailableReputation("authority-unavailable");
      last = { proposal: { origin: resource.origin, requestUrl: resource.toString(), requestId: id, requirements: r, normalisedAmount: NaN, assetSymbol: r.asset },
        decision: { verdict: "deny", reason, trace: ["authority:denied"], reputation } };
      journal.event(mandateId, id, "request.denied", { reason });
      return { abort: true, reason };
    }
  });
  client.onAfterPaymentCreation(async ctx => {
    const p = contexts.get(ctx.paymentRequired);
    if (closed || !p) throw new Error("No request-scoped authority for the created payment");
    journal.signed(p.id, ctx.paymentPayload);
    payloads.set(digest(ctx.paymentPayload), p);
    contexts.delete(ctx.paymentRequired);
  });
  client.onPaymentCreationFailure(async ctx => {
    const p = contexts.get(ctx.paymentRequired);
    if (p) { journal.fail(p.id, ctx.error.message); contexts.delete(ctx.paymentRequired); }
  });
  client.onPaymentResponse(async ctx => {
    const key = digest(ctx.paymentPayload), p = payloads.get(key);
    if (!p) return;
    payloads.delete(key);
    if (ctx.settleResponse?.success) {
      if (ctx.settleResponse.network !== ctx.requirements.network) {
        journal.fail(p.id, "Settlement network mismatch"); throw new Error("Settlement network mismatch");
      }
      const extra = ctx.settleResponse.extra as { chargedAmount?: string } | undefined;
      const charged = ctx.requirements.scheme === "exact" ? ctx.requirements.amount : extra?.chargedAmount;
      if (typeof charged !== "string") { journal.fail(p.id, "Missing actual settlement amount"); throw new Error("Missing actual settlement amount"); }
      journal.accept(p.id, charged, ctx.settleResponse);
    } else journal.fail(p.id, ctx.error?.message ?? "Payment outcome not established; reservation retained");
    await audit(p, ctx.settleResponse);
  });
  return { x402: client, getLastDecision: () => last,
    close: () => { closed = true; if (!opts.journal) journal.close(); } };
}

export function createMandateClient(opts: MandateClientOpts): MandateClient {
  const signer = opts.signer ?? createSealedHederaSigner(opts.hederaCiphertext, opts.accountId);
  const client = x402Client.fromConfig({
    schemes: [
      { network: "hedera:testnet", client: new ExactHederaScheme(signer) },
    ],
    spendControls: {
      allowedAssets: [
        { network: "hedera:testnet", asset: HBAR_ASSET_ID },
        { network: "hedera:testnet", asset: CIRCLE_HEDERA_TESTNET_USDC_HTS },
      ],
    },
  });
  return attachMandateHooks(client, opts);
}

/** Stock ExactEvmScheme / UptoEvmScheme with the same policy + HCS hooks. */
export function createMandateEvmClient(opts: MandateEvmClientOpts): MandateClient {
  const client = createEvmX402Client({
    signer: opts.evmSigner,
    rpcUrl: opts.rpcUrl,
    chainId: opts.chainId ?? 84532,
  });
  return attachMandateHooks(client, opts);
}
