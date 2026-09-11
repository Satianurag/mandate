import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPaymentScope, assertRequestScope, validateScope } from "./scope.ts";
import type { PaymentRequirements } from "@x402/core/types";
const s = validateScope({ network: "eip155:84532", serviceUrl: "http://127.0.0.1:8405/analytics", asset: "0x0000000000000000000000000000000000000001", receiver: "0x0000000000000000000000000000000000000002", receiverAuthorizer: "0x0000000000000000000000000000000000000003", withdrawDelay: 86400, expiresAt: new Date(Date.now()+3600000).toISOString(), ceilingBaseUnits: "5000000", perCallBaseUnits: "10000", windowBaseUnits: "100000", windowMs: 3600000 });
const r: PaymentRequirements = { scheme: "batch-settlement", network: s.network, asset: s.asset, payTo: s.receiver, amount: "10000", maxTimeoutSeconds: 60, extra: { receiverAuthorizer: s.receiverAuthorizer, withdrawDelay: s.withdrawDelay } };
test("scope rejects changed recipient, asset, network, channel, price and expiry", () => {
  assertPaymentScope(s,r);
  for (const changed of [{ payTo: s.asset }, { asset: s.receiver }, { network: "eip155:1" }, { amount: "10001" }, { extra: { ...r.extra, withdrawDelay: 60 } }]) {
    assert.throws(() => assertPaymentScope(s, { ...r, ...changed } as PaymentRequirements));
  }
  assert.throws(() => assertPaymentScope(s,r,Date.parse(s.expiresAt)), /expired/);
});
test("scope rejects foreign origins, paths, writes and caller payment credentials", () => {
  assertRequestScope(s, `${s.serviceUrl}?q=%7Bagents%7Bid%7D%7D`);
  for (const u of ["https://other.example/analytics", "http://127.0.0.1:8405/other", `${s.serviceUrl}?q=a&q=b`]) assert.throws(() => assertRequestScope(s,u));
  assert.throws(() => assertRequestScope(s,s.serviceUrl,{ method: "POST", body: "changed" }), /read-only/);
  assert.throws(() => assertRequestScope(s,s.serviceUrl,{ headers: { "payment-signature": "outside" } }), /forbidden/);
});


test("source-bound scope requires the exact reviewed chain and deployment", () => {
  const source = { provider: "the-graph" as const, chain: "bsc-chapel" as const, deployment: "BTjind17gmRZ6YhT9peaCM13SvWuqztsmqyfjpntbg3Z" };
  const bound = validateScope({ ...s, researchSource: source });
  const query = encodeURIComponent("{ agents(first: 2) { id } }");
  assertRequestScope(bound, `${bound.serviceUrl}?q=${query}&sourceChain=${source.chain}&sourceDeployment=${source.deployment}`);
  assert.throws(() => assertRequestScope(bound, `${bound.serviceUrl}?q=${query}`), /requires one query/);
  assert.throws(() => assertRequestScope(bound, `${bound.serviceUrl}?q=${query}&sourceChain=base-sepolia&sourceDeployment=${source.deployment}`), /outside the mandate/);
  assert.throws(() => assertRequestScope(bound, `${bound.serviceUrl}?q=${query}&sourceChain=${source.chain}&sourceDeployment=4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u`), /outside the mandate/);
  assertRequestScope(bound, bound.serviceUrl, undefined, true);
});
