/**
 * The circuit breaker.
 *
 * A systematic audit of 15 x402 facilitators covering >99% of observed volume
 * found violations in every one of them (arXiv:2607.19545). The recurring
 * shape of the problem, in the researchers' framing: an agent with no spending
 * policy has no circuit breaker. This module is that breaker.
 *
 * Three verdicts, and only three:
 *
 *   allow    -- settle headlessly, the agent never blocks
 *   step_up  -- hold, and require a Clear-signed confirmation on the device
 *   deny     -- refuse without ever producing a signature
 *
 * Design rule: every failure mode degrades toward `deny`, never toward
 * `allow`. An unreachable subgraph, an unreadable price, an unavailable
 * device -- none of these may open the gate.
 */

import type {
  CounterpartyReputation,
  PaymentProposal,
  PolicyDecision,
  Verdict,
} from "./types.ts";

export interface PolicyConfig {
  /** Above this, a single payment always requires the device. */
  perCallCeiling: number;
  /** Rolling spend cap and its window. */
  windowBudget: number;
  windowMs: number;
  /** Mean ERC-8004 score below which we refuse outright. */
  denyBelowScore: number;
  /** Mean score at or above which an unremarkable payment may pass unattended. */
  trustAtOrAboveScore: number;
  /** Minimum live feedback entries before a score is considered meaningful. */
  minFeedbackForTrust: number;
  /**
   * Below this, a payment may proceed even when some reputation registries
   * failed to answer. Above it, incomplete coverage either discounts the
   * score (weighted band) or escalates (hard gate).
   */
  trivialAmount: number;
  /**
   * Above this, incomplete registry coverage ALWAYS escalates, however good
   * the discounted score looks. Small payments flow on partial evidence;
   * anything that matters needs a human while registries are dark.
   * See docs/FINDINGS.md F18.
   */
  coverageGateAmount: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  perCallCeiling: 0.5,
  windowBudget: 5,
  windowMs: 60 * 60 * 1000,
  denyBelowScore: 0.35,
  trustAtOrAboveScore: 0.7,
  minFeedbackForTrust: 3,
  trivialAmount: 0.02,
  coverageGateAmount: 0.05,
};

/**
 * Shrinkage prior for scores computed from partial registry coverage.
 * An unread registry can only hide NEGATIVE signal, so missing coverage
 * pulls the score toward a pessimistic prior rather than blocking outright.
 * Calibrated in docs/FINDINGS.md F18 against 8 live counterparties.
 */
export const COVERAGE_PRIOR = 0.35;
/** Pseudo-observations at zero coverage; scales linearly with the gap. */
export const COVERAGE_K_MAX = 40;

/**
 * Discount a reputation score for unread registries (F18 hybrid).
 *
 *   coverage  = chainsReachable / chainsQueried
 *   k         = K_MAX * (1 - coverage)
 *   effective = (score*n + PRIOR*k) / (n + k)
 *
 * Full coverage returns the raw score untouched. Null stays null.
 */
export function effectiveScore(rep: CounterpartyReputation): number | null {
  if (rep.meanScore === null) return null;
  if (rep.chainsFailed.length === 0 || rep.chainsQueried === 0) return rep.meanScore;
  const coverage = rep.chainsReachable / rep.chainsQueried;
  const k = COVERAGE_K_MAX * (1 - coverage);
  const n = rep.feedbackCount;
  return (rep.meanScore * n + COVERAGE_PRIOR * k) / (n + k);
}

interface Spend {
  at: number;
  amount: number;
}

export class PolicyEngine {
  private spends: Spend[] = [];
  private readonly cfg: PolicyConfig;

  constructor(cfg: PolicyConfig = DEFAULT_POLICY) {
    this.cfg = cfg;
  }

  /** Total settled spend inside the rolling window. */
  spentInWindow(now = Date.now()): number {
    const cutoff = now - this.cfg.windowMs;
    this.spends = this.spends.filter((s) => s.at >= cutoff);
    return this.spends.reduce((sum, s) => sum + s.amount, 0);
  }

  /** Record a payment that actually settled. Only settled spend counts. */
  recordSettled(amount: number, now = Date.now()): void {
    this.spends.push({ at: now, amount });
  }

  evaluate(
    proposal: PaymentProposal,
    reputation: CounterpartyReputation,
    now = Date.now()
  ): PolicyDecision {
    const trace: string[] = [];
    const { cfg } = this;
    const amount = proposal.normalisedAmount;

    const decide = (verdict: Verdict, reason: string): PolicyDecision => ({
      verdict,
      reason,
      trace,
      reputation,
    });

    // --- hard refusals -----------------------------------------------------

    if (!Number.isFinite(amount) || amount <= 0) {
      trace.push("amount:unparseable");
      return decide("deny", "Quoted amount could not be parsed as a positive number.");
    }

    // Discount the score for unread registries BEFORE any threshold compares
    // against it, so the refusal floor and the trust threshold both see the
    // same evidence-weighted number. Amounts at or below `trivialAmount`
    // skip the discount: the exposure is too small to matter.
    const discounted =
      amount > cfg.trivialAmount ? effectiveScore(reputation) : reputation.meanScore;
    if (
      reputation.registered &&
      reputation.meanScore !== null &&
      discounted !== null &&
      discounted !== reputation.meanScore
    ) {
      trace.push(
        `reputation:score=${reputation.meanScore.toFixed(2)}->${discounted.toFixed(2)}` +
          ` coverage=${reputation.chainsReachable}/${reputation.chainsQueried}`
      );
    } else if (reputation.registered && reputation.meanScore !== null) {
      trace.push(`reputation:score=${reputation.meanScore.toFixed(2)}`);
    }

    if (reputation.registered && discounted !== null) {
      if (discounted < cfg.denyBelowScore) {
        return decide(
          "deny",
          `Counterparty carries an effective ERC-8004 score of ${discounted.toFixed(2)}, ` +
            `below the ${cfg.denyBelowScore} refusal floor.`
        );
      }
    }

    // A counterparty whose feedback has been largely revoked is a stronger
    // negative signal than a low score, because revocation is deliberate.
    if (reputation.revokedCount > reputation.feedbackCount) {
      trace.push(`reputation:revoked=${reputation.revokedCount}`);
      return decide(
        "deny",
        `Most feedback for this counterparty has been revoked (${reputation.revokedCount} revoked ` +
          `vs ${reputation.feedbackCount} live).`
      );
    }

    const spent = this.spentInWindow(now);
    trace.push(`budget:spent=${spent.toFixed(4)}/${cfg.windowBudget}`);
    if (spent + amount > cfg.windowBudget) {
      return decide(
        "deny",
        `Payment of ${amount} would exceed the rolling budget ` +
          `(${spent.toFixed(4)} of ${cfg.windowBudget} already spent this window).`
      );
    }

    // --- escalations -------------------------------------------------------

    if (amount > cfg.perCallCeiling) {
      trace.push(`amount:over-ceiling=${amount}`);
      return decide(
        "step_up",
        `Payment of ${amount} ${proposal.assetSymbol} exceeds the ` +
          `${cfg.perCallCeiling} per-call ceiling.`
      );
    }

    if (!reputation.registered) {
      trace.push("reputation:unregistered");
      return decide(
        "step_up",
        `${proposal.origin} has no ERC-8004 identity on any indexed chain. ` +
          `Unknown counterparties require confirmation.`
      );
    }

    if (
      reputation.meanScore === null ||
      reputation.feedbackCount < cfg.minFeedbackForTrust
    ) {
      trace.push(`reputation:thin=${reputation.feedbackCount}`);
      return decide(
        "step_up",
        `Counterparty is registered but has only ${reputation.feedbackCount} live feedback ` +
          `entries, below the ${cfg.minFeedbackForTrust} needed to pass unattended.`
      );
    }

    // An unread registry can only hide NEGATIVE signal -- nobody launders a
    // good reputation. So a high score computed from partial coverage is not
    // the same claim as one computed from full coverage. Measured 2026-09-08:
    // 3 of 9 Agent0 deployments were returning "bad indexers", so this fires
    // in practice. F18 hybrid: small payments flow on the discounted score;
    // anything above the coverage gate still needs a human while registries
    // are dark.
    if (reputation.chainsFailed.length > 0 && amount > cfg.coverageGateAmount) {
      trace.push(`coverage:gate@${cfg.coverageGateAmount} ${reputation.chainsReachable}/${reputation.chainsQueried}`);
      return decide(
        "step_up",
        `Could not read ${reputation.chainsFailed.length} of ` +
          `${reputation.chainsQueried} reputation registries ` +
          `(${reputation.chainsFailed.join(", ")}), and ${amount} ${proposal.assetSymbol} ` +
          `is above the ${cfg.coverageGateAmount} coverage gate. A registry we cannot read ` +
          `may hold negative feedback this score does not reflect.`
      );
    }

    if (discounted !== null && discounted < cfg.trustAtOrAboveScore) {
      trace.push("reputation:mid-band");
      return decide(
        "step_up",
        `Counterparty scores ${discounted.toFixed(2)}, between the refusal floor and ` +
          `the ${cfg.trustAtOrAboveScore} autonomy threshold.`
      );
    }

    // Nearing the budget edge is worth a human glance even when every
    // individual signal is fine.
    if (spent + amount > cfg.windowBudget * 0.9) {
      trace.push("budget:near-exhaustion");
      return decide(
        "step_up",
        `This payment would take the rolling window past 90% of its budget.`
      );
    }

    trace.push("allow:all-checks-passed");
    const shown = (discounted ?? reputation.meanScore ?? 0).toFixed(2);
    return decide(
      "allow",
      `Counterparty scores ${shown} across ` +
        `${reputation.feedbackCount} entries; ${amount} ${proposal.assetSymbol} is within ceiling and budget.`
    );
  }
}
