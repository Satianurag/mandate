/**
 * Mandate's x402 client: stock payment flow, Mandate judgment.
 *
 * The payment mechanics are entirely stock -- `x402Client` + the Hedera
 * `exact` scheme + `wrapFetchWithPayment` handle the 402, payload assembly,
 * signing, header encoding, retry, and settlement parsing. Mandate plugs in
 * at the two hook points the SDK provides for exactly this:
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
import { policyEngine } from "./policy.ts";
import { lookupCounterparty, AGENT0_SUBGRAPHS } from "./reputation.ts";
import { normaliseAmount, createSealedHederaSigner } from "./hedera.ts";
import { buildRecord, submit } from "./audit.ts";
import { deriveOperatorUaid } from "./uaid.ts";
import type { SettleResponse } from "./types.ts";
import { requireDeviceApproval, StepUpDenied, type StepUpDeps } from "./stepup.ts";
import { withSecret } from "./keyring.ts";
import type {
  CounterpartyReputation,
  PaymentProposal,
  PolicyDecision,
} from "./types.ts";

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
  deps: { stepUp?: StepUpDeps } = {}
): Promise<{ proposal: PaymentProposal; decision: PolicyDecision }> {
  let proposal: PaymentProposal;
  try {
    const { amount, symbol } = normaliseAmount(requirements);
    proposal = { origin, requirements, normalisedAmount: amount, assetSymbol: symbol };
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

  const decision = policyEngine.evaluate(proposal, reputation);

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
    return new URL(url).origin;
  } catch {
    return "unknown-origin";
  }
}

export interface MandateClientOpts {
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
  /**
   * Signer override. Production omits this and gets the sealed signer;
   * hermetic tests inject an ephemeral-key stock signer so the full
   * pay→settle loop runs without the Key Ring or the network (same DI
   * pattern as the step-up device).
   */
  signer?: ClientHederaSigner;
}

export interface MandateClient {
  x402: x402Client;
  /**
   * The last judgment made by the before-hook, if any. The proxy uses it to
   * map an aborted payment to a 403 with the real reason -- without parsing
   * SDK error strings.
   */
  getLastDecision: () => { proposal: PaymentProposal; decision: PolicyDecision } | undefined;
}

export function createMandateClient(opts: MandateClientOpts): MandateClient {
  const signer = opts.signer ?? createSealedHederaSigner(opts.hederaCiphertext, opts.accountId);
  let last: { proposal: PaymentProposal; decision: PolicyDecision } | undefined;
  let audited = false;

  // Audit submission never blocks the payment path and never throws: the
  // record must not slow the verdict, and a logging failure must not fail
  // a payment the policy engine already allowed.
  //
  // The operator UAID is derived per record from the payment's own network,
  // so the identity can never disagree with the rail the verdict ran on.
  // Derivation is offline and cached; if it ever fails, the verdict is
  // still recorded without attribution (load-bearing first, UAID second).
  const uaidCache = new Map<string, Promise<string>>();
  const auditVerdict = (
    proposal: PaymentProposal,
    decision: PolicyDecision,
    settlement?: SettleResponse
  ) => {
    if (!opts.hcsTopic) return;
    const topic = opts.hcsTopic;
    void withSecret("hedera-payment", opts.hederaCiphertext, async (key) => {
      let operatorUaid: string | undefined;
      try {
        const network = proposal.requirements.network;
        let cached = uaidCache.get(network);
        if (!cached) {
          cached = deriveOperatorUaid(opts.accountId, network);
          uaidCache.set(network, cached);
        }
        operatorUaid = await cached;
      } catch (e) {
        console.warn(
          `[audit] UAID derivation failed, recording without it: ${e instanceof Error ? e.message : e}`
        );
      }
      await submit(topic, buildRecord(proposal, decision, settlement, operatorUaid), {
        accountId: opts.accountId,
        privateKeyHex: key.toString("utf8").trim(),
      });
    });
  };

  const client = x402Client.fromConfig({
    schemes: [
      { network: "hedera:testnet", client: new ExactHederaScheme(signer) },
      { network: "hedera:mainnet", client: new ExactHederaScheme(signer) },
    ],
    // HBAR is not a stock default asset, so without this opt-in the SDK
    // would filter every HBAR requirement before our hook ever sees it.
    // Uncapped here on purpose: the policy engine owns the ceiling, because
    // an over-ceiling payment must ESCALATE (step_up) rather than hard-deny.
    spendControls: {
      allowedAssets: [
        { network: "hedera:testnet", asset: HBAR_ASSET_ID },
        { network: "hedera:mainnet", asset: HBAR_ASSET_ID },
      ],
    },
  });

  client
    .onBeforePaymentCreation(async (ctx) => {
      const out = await decide(
        originOf(ctx.paymentRequired),
        ctx.selectedRequirements,
        opts.graphApiKey,
        { stepUp: opts.stepUp }
      );
      last = { proposal: out.proposal, decision: out.decision };
      if (out.decision.verdict === "deny") {
        auditVerdict(out.proposal, out.decision);
        return { abort: true, reason: out.decision.reason };
      }
    })
    .onPaymentResponse(async (ctx) => {
      // Exactly once per payment: the accrual and the audit record must
      // exist if and only if a payment was actually created.
      if (!last || audited) return;
      audited = true;
      if (ctx.settleResponse?.success) {
        policyEngine.recordSettled(last.proposal.normalisedAmount);
      }
      auditVerdict(last.proposal, last.decision, ctx.settleResponse);
    });

  return { x402: client, getLastDecision: () => last };
}
