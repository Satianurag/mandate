/** Broker policy over ERC-8004 reputation lookups. Advisory scores never grant spending authority. */
import type { CounterpartyReputation, PolicyDecision } from "./types.ts";

const emptyReputation = (): CounterpartyReputation => ({
  registered: false,
  feedbackCount: 0,
  meanScore: null,
  revokedCount: 0,
  validationCount: 0,
  chainsQueried: 0,
  chainsReachable: 0,
  chainsFailed: [],
});

export function evaluateCounterpartyPolicy(reputation: CounterpartyReputation): PolicyDecision {
  const trace: string[] = [];
  if (reputation.chainsQueried > 0 && reputation.chainsReachable === 0) {
    trace.push("No Agent0 registry deployment answered; autonomous payment blocked.");
    return { verdict: "deny", reason: "Counterparty reputation registries are unreachable", trace, reputation };
  }
  if (reputation.chainsFailed.length > 0) {
    trace.push(`Partial registry coverage (${reputation.chainsFailed.join(", ")} failed).`);
    return {
      verdict: "deny",
      reason: `Incomplete Agent0 registry coverage (${reputation.chainsFailed.join(", ")} failed)`,
      trace,
      reputation,
    };
  }
  trace.push("Registry coverage complete for the reviewed lookup.");
  return { verdict: "allow", reason: "Counterparty lookup completed", trace, reputation };
}

export function skippedCounterpartyPolicy(reason: string): PolicyDecision {
  return { verdict: "allow", reason, trace: [reason], reputation: emptyReputation() };
}
