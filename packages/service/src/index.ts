/**
 * The paid counterpart.
 *
 * Hedera's track requires a live x402-gated service AND a consuming platform
 * that completes real paid requests end to end. We ship both sides, so the
 * demo does not depend on a third party's endpoint staying up during judging.
 */

import { createServer } from "node:http";
import {
  verify,
  settle,
  encodePaymentHeader,
  normaliseAmount,
} from "../../gateway/src/hedera.ts";
import { BLOCKY402_TESTNET } from "../../gateway/src/facilitators.ts";
import type { PaymentPayload, PaymentRequirements } from "../../gateway/src/types.ts";

const PORT = Number(process.env.SERVICE_PORT ?? 8403);
const HOST = process.env.SERVICE_HOST ?? "127.0.0.1";

/**
 * The fee payer is NEVER hardcoded (invariant 3): a rotated facilitator key
 * would otherwise produce confusing "invalid transaction" failures. It is
 * read from the facilitator's live /supported at boot, and the service
 * refuses to start if the advertisement is missing — fail fast at boot,
 * not per-request. SERVICE_FEE_PAYER overrides only for hermetic tests.
 */
async function resolveFeePayer(): Promise<string> {
  if (process.env.SERVICE_FEE_PAYER) return process.env.SERVICE_FEE_PAYER;
  const res = await fetch(`${BLOCKY402_TESTNET.baseUrl}/supported`);
  if (!res.ok) throw new Error(`${BLOCKY402_TESTNET.name}: /supported returned ${res.status}`);
  const body = (await res.json()) as {
    kinds?: { scheme?: string; network?: string; extra?: { feePayer?: string } }[];
  };
  const kind = (body.kinds ?? []).find(
    (k) => k.scheme === "exact" && k.network === "hedera:testnet"
  );
  if (!kind?.extra?.feePayer) {
    throw new Error(
      `${BLOCKY402_TESTNET.name} no longer advertises exact@hedera:testnet with a feePayer`
    );
  }
  return kind.extra.feePayer;
}

const PAY_TO =
  process.env.SERVICE_PAY_TO ?? process.env.MANDATE_HEDERA_ACCOUNT_ID ?? "";
if (!PAY_TO || PAY_TO === "0.0.0") {
  console.error("Set SERVICE_PAY_TO or MANDATE_HEDERA_ACCOUNT_ID before starting the paid service.");
  process.exit(1);
}
const FEE_PAYER = await resolveFeePayer().catch((e: unknown) => {
  console.error(`Cannot start paid service: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

/** Tinybars. 1 HBAR = 1e8 tinybars. */
const BASE_PRICE = 2_000_000n;

function quote(query: string): bigint {
  const depth = (query.match(/\{/g) ?? []).length;
  const fields = (query.match(/\w+(?=\s*[\{\n])/g) ?? []).length;
  return BASE_PRICE + BigInt(depth) * 500_000n + BigInt(fields) * 100_000n;
}

function requirementsFor(url: URL, amount: bigint): PaymentRequirements {
  return {
    scheme: "exact",
    network: "hedera:testnet",
    asset: "0.0.0",
    amount: amount.toString(),
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    resource: `${url.origin}${url.pathname}${url.search}`,
    description: "Subgraph analytics — metered by complexity",
    extra: { feePayer: FEE_PAYER },
  };
}

function decodePaymentHeader(header: string): PaymentPayload {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentPayload;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/analytics") {
    res.writeHead(404).end();
    return;
  }

  const query = url.searchParams.get("q") ?? "{ agents { id } }";
  const amount = quote(query);
  const requirements = requirementsFor(url, amount);
  const paymentHeader = req.headers["x-payment"];

  if (!paymentHeader || Array.isArray(paymentHeader)) {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        x402Version: 2,
        accepts: [requirements],
      })
    );
    return;
  }

  try {
    const payload = decodePaymentHeader(paymentHeader);
    const check = await verify(BLOCKY402_TESTNET, requirements, payload);
    if (!check.isValid) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          x402Version: 2,
          accepts: [requirements],
          error: check.invalidReason ?? "invalid payment",
        })
      );
      return;
    }

    const settlement = await settle(BLOCKY402_TESTNET, requirements, payload);
    if (!settlement.success) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          x402Version: 2,
          accepts: [requirements],
          error: settlement.errorReason ?? "settlement failed",
        })
      );
      return;
    }

    const { amount: human, symbol } = normaliseAmount(requirements);
    const txId = settlement.transactionId ?? settlement.transaction;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        query,
        paid: { amount: human, asset: symbol, txId },
        rows: [{ id: "agent-demo-1", feedbackCount: 42 }],
      })
    );
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}).listen(PORT, HOST, () => console.log(`paid service on ${HOST}:${PORT} (feePayer ${FEE_PAYER})`));

export { encodePaymentHeader, requirementsFor, quote };
