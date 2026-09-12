#!/usr/bin/env node
/**
 * Unpaid x402 probes: vendor 402s + first-party challenge path.
 * Never sends a payment-signature, never calls /verify or /settle.
 */
import { createServer } from "node:http";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { getAddress } from "viem";
import { createAgentTools } from "../../packages/gateway/src/agent-tools.ts";
import { createAgentToolService } from "../../packages/gateway/src/agent-tool-service.ts";
import { Journal } from "../../packages/gateway/src/journal.ts";
import { EXACT_USDC } from "../../packages/gateway/src/agent-exact.ts";

const USDC = getAddress(EXACT_USDC["eip155:8453"]);
const report = { ok: false, paymentMade: false, verified: false, settled: false, vendors: [], firstParty: null, error: null };

function assertOffer(header, label) {
  if (!header) throw new Error(`${label}: missing payment-required`);
  const required = decodePaymentRequiredHeader(header);
  const offer = required.accepts.find(
    (o) =>
      o.scheme === "exact" &&
      o.network === "eip155:8453" &&
      getAddress(o.asset) === USDC &&
      o.extra?.name === "USD Coin" &&
      o.extra?.version === "2"
  );
  if (!offer) throw new Error(`${label}: no exact Base mainnet USDC offer`);
  return { amount: offer.amount, payTo: getAddress(offer.payTo), network: offer.network };
}

try {
  const catalog = createAgentTools();
  const samples = {
    "web-search": { query: "x402 payment protocol official documentation", numResults: 1 },
    "crypto-news": {},
    "crypto-prices": { coins: ["BTC"] },
  };
  for (const tool of catalog) {
    const request = tool.request(samples[tool.id]);
    const response = await fetch(request.url, {
      method: request.method,
      body: request.body,
      headers: request.body ? { "content-type": "application/json" } : {},
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    const header = response.headers.get("payment-required");
    await response.body?.cancel();
    if (response.status !== 402) throw new Error(`${tool.id}: expected 402, got ${response.status}`);
    report.vendors.push({ id: tool.id, status: 402, ...assertOffer(header, tool.id) });
  }

  const counts = { verify: 0, settle: 0 };
  const facilitator = createServer(async (req, res) => {
    req.resume();
    await new Promise((resolve) => req.on("end", resolve));
    res.setHeader("content-type", "application/json");
    if (req.url === "/supported") {
      res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
      return;
    }
    if (req.url === "/verify") counts.verify++;
    if (req.url === "/settle") counts.settle++;
    res.statusCode = 501;
    res.end(JSON.stringify({ error: "unpaid probe does not settle" }));
  });
  const facilitatorUrl = await new Promise((resolve) =>
    facilitator.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${facilitator.address().port}`))
  );
  const journal = new Journal(":memory:");
  const server = await createAgentToolService({
    network: "eip155:8453",
    payTo: "0x57a2a47Ca22AE52867c5313c4d9ab43070D7C202",
    facilitatorUrl,
    journal,
    providers: [
      {
        id: "crypto-prices",
        description: "Unpaid first-party challenge",
        amountBaseUnits: "1000",
        validate() {},
        async execute() {
          throw new Error("provider must not run on an unpaid probe");
        },
      },
    ],
  });
  const origin = await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))
  );
  const challenge = await fetch(`${origin}/tools/crypto-prices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ coins: ["BTC"] }),
    signal: AbortSignal.timeout(10000),
  });
  const header = challenge.headers.get("payment-required");
  await challenge.body?.cancel();
  if (challenge.status !== 402) throw new Error(`first-party: expected 402, got ${challenge.status}`);
  report.firstParty = { status: 402, verify: counts.verify, settle: counts.settle, ...assertOffer(header, "first-party") };
  if (counts.verify || counts.settle) throw new Error("first-party unpaid probe touched verify or settle");
  await new Promise((resolve) => server.close(() => resolve()));
  await new Promise((resolve) => facilitator.close(() => resolve()));
  journal.close();
  report.ok = true;
} catch (e) {
  report.error = e instanceof Error ? e.message : String(e);
}

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
