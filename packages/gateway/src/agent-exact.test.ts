import { test } from "node:test";
import assert from "node:assert/strict";
import { Journal } from "./journal.ts";
import { AgentStore } from "./agent-store.ts";
import { ExactAgentExecutor, EXACT_USDC, type ExactAgentAuthority } from "./agent-exact.ts";
import { createAgentTools } from "./agent-tools.ts";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
const address = "0x57a2a47Ca22AE52867c5313c4d9ab43070D7C202";
const recipient = "0x0000000000000000000000000000000000000002";
function fixture(t: { after: (f: () => void) => void }, behavior: "success" | "uncertain" | "recipient-change" = "success") {
  const journal = new Journal(":memory:"); t.after(() => journal.close());
  const store = new AgentStore(journal.db);
  const authority: ExactAgentAuthority = { id: "exact-test", network: "eip155:8453", asset: EXACT_USDC["eip155:8453"], payerAddress: address, spendingAddress: address, expiresAt: Date.now() + 7200000, ceilingBaseUnits: "5000000", perCallBaseUnits: "20000", windowBaseUnits: "5000000", windowMs: 3600000, tools: [{ id: "web-search", origin: "https://api.exa.ai", pathname: "/search", payTo: recipient }] };
  const offer: PaymentRequirements = { scheme: "exact", network: authority.network, asset: authority.asset, amount: "10000", payTo: behavior === "recipient-change" ? address : recipient, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" } };
  let signatures = 0, requests = 0, verified = 0;
  const executor = new ExactAgentExecutor({ authority, journal, tools: createAgentTools(), signer: { address, signTypedData: async () => { signatures++; return `0x${"11".repeat(65)}`; } }, verify: async () => { verified++; }, fetch: (async (_url, init) => {
    requests++;
    if (!new Headers(init?.headers).has("payment-signature")) return new Response(null, { status: 402, headers: { "payment-required": encodePaymentRequiredHeader({ x402Version: 2, accepts: [offer], resource: { url: "https://api.exa.ai/search" } }) } });
    if (behavior === "uncertain") throw new Error("Connection lost after payment submission");
    return new Response(JSON.stringify({ results: [{ title: "Evidence", url: "https://example.org/source" }] }), { status: 200, headers: { "payment-response": encodePaymentResponseHeader({ success: true, transaction: `0x${"aa".repeat(32)}`, network: authority.network, payer: address }) } });
  }) as typeof fetch });
  const run = store.createRun({ id: "exact-run-123", agentId: "protocol-investigator", goal: "Investigate", authorityId: authority.id });
  return { executor, journal, authority, run, counts: () => ({ signatures, requests, verified }), fund() { journal.depositOnce(authority.id); journal.funded(authority.id, { hermeticFixture: true }); } };
}
test("exact x402 obtains a quote, requires funding, then reserves, signs once and retains verified evidence", async t => {
  const f = fixture(t), signal = new AbortController().signal;
  let quote = await f.executor.quote("web-search", { query: "protocol evidence" }, signal);
  await assert.rejects(f.executor.execute({ run: f.run, quote, requestId: "unfunded", remainingBaseUnits: "100000", signal }), /funding/);
  assert.equal(f.counts().signatures, 0);
  f.fund(); quote = await f.executor.quote("web-search", { query: "protocol evidence" }, signal);
  const observation = await f.executor.execute({ run: f.run, quote, requestId: "paid-request", remainingBaseUnits: "100000", signal });
  assert.equal(observation.receipt.amountBaseUnits, "10000"); assert.equal(f.counts().signatures, 1); assert.equal(f.counts().verified, 1);
  assert.equal(f.journal.request("paid-request")!.state, "accepted");
  assert.ok(f.journal.request("paid-request")!.response?.includes("Evidence"));
  await assert.rejects(f.executor.execute({ run: f.run, quote, requestId: "repeat", remainingBaseUnits: "100000", signal }), /expired or changed/);
  assert.equal(f.counts().signatures, 1);
});
test("uncertain exact payment remains reserved and blocks subsequent signatures", async t => {
  const f = fixture(t, "uncertain"); f.fund(); const signal = new AbortController().signal;
  const quote = await f.executor.quote("web-search", { query: "evidence" }, signal);
  await assert.rejects(f.executor.execute({ run: f.run, quote, requestId: "unknown-outcome", remainingBaseUnits: "100000", signal }), /Connection lost/);
  assert.equal(f.journal.request("unknown-outcome")!.state, "uncertain");
  const second = await f.executor.quote("web-search", { query: "more evidence" }, signal);
  await assert.rejects(f.executor.execute({ run: f.run, quote: second, requestId: "second-payment", remainingBaseUnits: "100000", signal }), /Reconcile/);
  assert.equal(f.counts().signatures, 1);
});
test("unapproved recipients and model-supplied URLs cannot reach signing", async t => {
  const f = fixture(t, "recipient-change"), signal = new AbortController().signal;
  await assert.rejects(f.executor.quote("web-search", { query: "evidence" }, signal), /No offer matches/);
  await assert.rejects(f.executor.quote("web-search", { query: "evidence", url: "https://attacker.invalid" }, signal), /unsupported field/);
  assert.equal(f.counts().signatures, 0); assert.equal(f.counts().requests, 1);
});
test("shared and per-run budgets are enforced atomically and run limits cannot be increased", t => {
  const journal = new Journal(":memory:"); t.after(() => journal.close());
  const limits = { ceilingBaseUnits: "100", perCallBaseUnits: "50", windowBaseUnits: "100", windowMs: 60000 };
  journal.register("shared", limits);
  const request = { mandateId: "shared", digest: "intent", network: "eip155:8453", asset: "USDC", amount: "40", limits, group: { id: "one-run", ceilingBaseUnits: "50", perCallBaseUnits: "50" } };
  journal.reserve({ ...request, id: "first" });
  assert.throws(() => journal.reserve({ ...request, id: "second" }), /Run lifetime/);
  assert.throws(() => journal.reserve({ ...request, id: "increase", group: { ...request.group, ceilingBaseUnits: "100" } }), /immutable/);
  assert.equal(journal.request("second"), undefined);
  journal.reserve({ ...request, id: "another-run", group: { ...request.group, id: "two-run" } });
  assert.throws(() => journal.reserve({ ...request, id: "third-run", group: { ...request.group, id: "three-run" } }), /Lifetime budget/);
  assert.equal(journal.totals("shared", 60000).reserved, "80");
});
