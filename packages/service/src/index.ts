/**
 * The paid counterpart.
 *
 * Hedera's track requires a live x402-gated service AND a consuming platform
 * that completes real paid requests end to end. We ship both sides, so the
 * demo does not depend on a third party's endpoint staying up during judging.
 *
 * What it sells: subgraph analytics. Price scales with query complexity, which
 * satisfies the "per-call inference metering" bonus criterion -- a flat price
 * would not.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.SERVICE_PORT ?? 8403);

/** Verified live 2026-09-08 against GET /supported. */
const FEE_PAYER = "0.0.7162784";
const PAY_TO = process.env.SERVICE_PAY_TO ?? "0.0.0";

/** Tinybars. 1 HBAR = 1e8 tinybars. */
const BASE_PRICE = 2_000_000n;

/** Price the request before serving it. Complexity is the meter. */
function quote(query: string): bigint {
  const depth = (query.match(/\{/g) ?? []).length;
  const fields = (query.match(/\w+(?=\s*[\{\n])/g) ?? []).length;
  return BASE_PRICE + BigInt(depth) * 500_000n + BigInt(fields) * 100_000n;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/analytics") {
    res.writeHead(404).end();
    return;
  }

  const query = url.searchParams.get("q") ?? "{ agents { id } }";
  const amount = quote(query);
  const payment = req.headers["x-payment"];

  if (!payment) {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "hedera:testnet",
            asset: "0.0.0",
            amount: amount.toString(),
            payTo: PAY_TO,
            maxTimeoutSeconds: 60,
            resource: `${url.origin}/analytics`,
            description: `Subgraph analytics — ${query.length} chars, metered by complexity`,
            extra: { feePayer: FEE_PAYER },
          },
        ],
      })
    );
    return;
  }

  // TODO(day-2): verify the payment with the facilitator BEFORE serving.
  // The audit's "free shopping" class is exactly the failure of releasing a
  // service before settlement confirms. Do not shortcut this for the demo.
  res.writeHead(501, { "content-type": "text/plain" });
  res.end("settlement verification lands Day 2 — see docs/plan.md\n");
}).listen(PORT, () => console.log(`paid service on :${PORT}`));
