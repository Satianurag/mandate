/**
 * Mandate -- a hardware trust boundary for x402 agent payments.
 *
 * Runs as a local HTTP proxy in front of the agent. The agent makes ordinary
 * requests; Mandate intercepts the 402, decides whether the payment should
 * happen, obtains a signature under the right conditions, settles, and retries.
 */

import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PolicyEngine, DEFAULT_POLICY } from "./policy.ts";
import { lookupCounterparty } from "./reputation.ts";
import {
  normaliseAmount,
  buildAndSign,
  verify,
  settle,
  encodePaymentHeader,
  buildPaymentPayload,
} from "./hedera.ts";
import { BLOCKY402_TESTNET, X402_FOUNDATION } from "./facilitators.ts";
import { buildRecord, submit } from "./audit.ts";
import { requireDeviceApproval, StepUpDenied } from "./stepup.ts";
import { withSecret } from "./keyring.ts";
import type { PaymentProposal, PaymentRequiredBody, PaymentPayload } from "./types.ts";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PORT = Number(process.env.MANDATE_PORT ?? process.env.BREAKER_PORT ?? 8402);
const UPSTREAM = process.env.MANDATE_UPSTREAM ?? "http://127.0.0.1:8403/analytics";
const HCS_TOPIC = process.env.MANDATE_HCS_TOPIC_ID;
const GRAPH_KEY_PATH =
  process.env.MANDATE_GRAPH_KEY_ENC ?? join(PROJECT_ROOT, "secrets/graph.enc");
const HEDERA_KEY_PATH =
  process.env.MANDATE_HEDERA_KEY_ENC ?? join(PROJECT_ROOT, "secrets/hedera.enc");

const policy = new PolicyEngine(DEFAULT_POLICY);

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

  const reputation = await lookupCounterparty(requirements.payTo, graphApiKey).catch(
    () => ({
      registered: false,
      feedbackCount: 0,
      meanScore: null,
      revokedCount: 0,
      validationCount: 0,
      chainsQueried: 0,
      chainsReachable: 0,
      chainsFailed: [] as string[],
    })
  );

  const decision = policy.evaluate(proposal, reputation);

  if (decision.verdict === "step_up") {
    try {
      await requireDeviceApproval({
        proposal,
        reason: decision.reason,
        timeoutMs: Number(process.env.MANDATE_STEPUP_TIMEOUT_MS ?? 120_000),
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

  return { proposal, decision, reputation };
}

/** After policy allows payment, sign, verify, settle, and audit. */
export async function executePayment(
  out: Awaited<ReturnType<typeof decide>>,
  hederaKeyCiphertext: Buffer,
  facilitator = BLOCKY402_TESTNET
) {
  if (out.decision.verdict === "deny") {
    return { ok: false as const, decision: out.decision };
  }

  const requirements = out.proposal.requirements;
  const transaction = await withSecret("hedera-payment", hederaKeyCiphertext, (key) =>
    buildAndSign(requirements, key)
  );

  const payload = buildPaymentPayload(requirements, transaction, out.proposal.origin);

  const check = await verify(facilitator, requirements, payload);
  if (!check.isValid) {
    return {
      ok: false as const,
      decision: {
        ...out.decision,
        verdict: "deny" as const,
        reason: check.invalidReason ?? "facilitator rejected payment",
      },
    };
  }

  const settlement = await settle(facilitator, requirements, payload);
  const record = buildRecord(out.proposal, out.decision, settlement);
  if (HCS_TOPIC) {
    void withSecret("hedera-payment", hederaKeyCiphertext, async (key) => {
      const accountId = process.env.MANDATE_HEDERA_ACCOUNT_ID;
      if (!accountId) {
        console.warn("[audit] MANDATE_HEDERA_ACCOUNT_ID unset — record not submitted");
        return;
      }
      await submit(HCS_TOPIC, record, {
        accountId,
        privateKeyHex: key.toString("utf8").trim(),
      });
    });
  }

  return {
    ok: settlement.success,
    decision: out.decision,
    settlement,
    paymentHeader: encodePaymentHeader(payload),
    record,
  };
}

async function loadGraphKey(): Promise<string> {
  if (process.env.GRAPH_API_KEY) return process.env.GRAPH_API_KEY;
  const { readFile } = await import("node:fs/promises");
  const enc = await readFile(GRAPH_KEY_PATH);
  return withSecret("graph-gateway", enc, (buf) =>
    Promise.resolve(buf.toString("utf8").trim())
  );
}

async function loadHederaKeyEnc(): Promise<Buffer> {
  const { readFile } = await import("node:fs/promises");
  return readFile(HEDERA_KEY_PATH);
}

/** Proxy one upstream URL through decide → pay → retry. */
export async function proxyFetch(upstreamUrl: string, init?: RequestInit) {
  const origin = new URL(upstreamUrl).origin;
  let res = await fetch(upstreamUrl, init);

  if (res.status !== 402) return res;

  const challenge = (await res.json()) as PaymentRequiredBody;
  const graphKey = await loadGraphKey().catch(() => "deliberately-invalid-key");
  const out = await decide(origin, challenge, graphKey);

  if (out.decision.verdict === "deny") {
    return new Response(JSON.stringify({ error: out.decision.reason, trace: out.decision.trace }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  let hederaEnc: Buffer;
  try {
    hederaEnc = await loadHederaKeyEnc();
  } catch {
    return new Response(
      JSON.stringify({
        error: "Hedera signing key not sealed — see docs/plan.md pre-code checklist",
      }),
      { status: 503, headers: { "content-type": "application/json" } }
    );
  }

  const paid = await executePayment(out, hederaEnc);
  if (!paid.ok || !paid.paymentHeader) {
    return new Response(JSON.stringify({ error: paid.decision.reason }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  const headers = new Headers(init?.headers);
  headers.set("x-payment", paid.paymentHeader);
  return fetch(upstreamUrl, { ...init, headers });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    if (url.pathname !== "/proxy") {
      res.writeHead(404).end("Use GET /proxy?q=…\n");
      return;
    }
    const target = new URL(UPSTREAM);
    target.search = url.search;

    try {
      const upstream = await proxyFetch(target.toString(), {
        method: req.method ?? "GET",
        headers: req.headers as HeadersInit,
      });
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });

  server.listen(PORT, () => {
    console.log(`Mandate listening on :${PORT}`);
    console.log(`  proxy        GET /proxy → ${UPSTREAM}`);
    console.log(`  envelope     ${X402_FOUNDATION.name} · batch-settlement@eip155:84532`);
    console.log(`  hedera       ${BLOCKY402_TESTNET.name} · exact@hedera:testnet`);
    console.log(`  per-call     ${DEFAULT_POLICY.perCallCeiling}`);
    console.log(`  window       ${DEFAULT_POLICY.windowBudget} / ${DEFAULT_POLICY.windowMs / 3.6e6}h`);
    console.log(`  custody      Ledger Key Ring (no .env secrets)`);
  });
}
