/**
 * Mandate -- a hardware trust boundary for x402 agent payments.
 *
 * Runs as a local HTTP proxy in front of the agent. The agent makes ordinary
 * requests; Mandate intercepts the 402, decides whether the payment should
 * happen, obtains a signature under the right conditions, settles, and retries.
 *
 * The agent never sees a key, and never sees the decision -- only the result.
 */

import { createServer } from "node:http";
import { PolicyEngine, DEFAULT_POLICY } from "./policy.ts";
import { lookupCounterparty } from "./reputation.ts";
import { normaliseAmount } from "./hedera.ts";
import { BLOCKY402_TESTNET, X402_FOUNDATION } from "./facilitators.ts";
import { buildRecord } from "./audit.ts";
import { requireDeviceApproval, StepUpDenied } from "./stepup.ts";
import type { PaymentProposal, PaymentRequiredBody } from "./types.ts";

const PORT = Number(process.env.BREAKER_PORT ?? 8402);

const policy = new PolicyEngine(DEFAULT_POLICY);

/**
 * Handle one 402 challenge.
 *
 * Returns the decision so the caller can log it and, on `allow` or an approved
 * `step_up`, proceed to settlement.
 */
export async function decide(
  origin: string,
  challenge: PaymentRequiredBody,
  graphApiKey: string
) {
  const requirements = challenge.accepts[0];
  if (!requirements) {
    throw new Error("402 response carried no payment requirements.");
  }

  const { amount, symbol } = normaliseAmount(requirements);
  const proposal: PaymentProposal = {
    origin,
    requirements,
    normalisedAmount: amount,
    assetSymbol: symbol,
  };

  // Reputation lookup must not be able to open the gate by failing. A subgraph
  // that is unreachable yields an unregistered counterparty, which escalates.
  const reputation = await lookupCounterparty(requirements.payTo, graphApiKey).catch(
    () => ({
      registered: false,
      feedbackCount: 0,
      meanScore: null,
      revokedCount: 0,
      validationCount: 0,
    })
  );

  const decision = policy.evaluate(proposal, reputation);

  if (decision.verdict === "step_up") {
    try {
      await requireDeviceApproval({
        proposal,
        reason: decision.reason,
        timeoutMs: 120_000,
      });
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer((_req, res) => {
    res.writeHead(501, { "content-type": "text/plain" });
    res.end("Mandate proxy: request path lands Day 2. See docs/plan.md\n");
  });
  server.listen(PORT, () => {
    console.log(`Mandate listening on :${PORT}`);
    console.log(`  envelope     ${X402_FOUNDATION.name} · batch-settlement@eip155:84532`);
    console.log(`  hedera       ${BLOCKY402_TESTNET.name} · exact@hedera:testnet`);
    console.log(`  per-call     ${DEFAULT_POLICY.perCallCeiling}`);
    console.log(`  window       ${DEFAULT_POLICY.windowBudget} / ${DEFAULT_POLICY.windowMs / 3.6e6}h`);
    console.log(`  custody      Ledger Key Ring (no .env secrets)`);
  });
  void buildRecord;
}
