/**
 * F21 through the real stock loop: ephemeral key, in-process service, stub
 * facilitator. No secrets, no network -- but every layer is the production
 * layer (stock client, mandate hooks, stock server), not a unit-test double
 * of the wiring itself.
 *
 * - settled spend accrues exactly once per successful settlement;
 * - failed settlement accrues nothing;
 * - deny short-circuits without touching sign/verify/settle.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapFetchWithPayment } from "@x402/fetch";
import {
  PrivateKey,
  createClientHederaSigner,
  type ClientHederaSigner,
} from "@x402/hedera";
import { policyEngine } from "./policy.ts";
import { createMandateClient } from "./client.ts";
import { startStubFacilitator } from "./facilitator-stub.ts";
import { quote, buildService } from "../../service/src/index.ts";

const PAYER = "0.0.54321";
const PAY_TO = "0.0.5005";
const QUERY = "{ agents { id } }";

async function startService(t: { after: (fn: () => void) => void }, facilitatorUrl: string) {
  const server = await buildService({
    payTo: PAY_TO,
    facilitatorUrl,
    port: 0,
    host: "127.0.0.1",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  return `http://127.0.0.1:${port}/analytics?q=${encodeURIComponent(QUERY)}`;
}

/** Ephemeral offline signer: real stock signing, no Key Ring, no network. */
function ephemeralSigner(counter?: { signs: number }): ClientHederaSigner {
  const inner = createClientHederaSigner(PAYER, PrivateKey.generateECDSA(), {
    network: "hedera:testnet",
  });
  return {
    accountId: PAYER,
    createPartiallySignedTransferTransaction: async (requirements) => {
      if (counter) counter.signs++;
      return inner.createPartiallySignedTransferTransaction(requirements);
    },
  };
}

test("F21: settled spend accrues exactly once per successful settlement", async (t) => {
  const stub = await startStubFacilitator(t);
  const url = await startService(t, stub.url);
  const { x402 } = createMandateClient({
    hederaCiphertext: Buffer.from("unused-injected-signer"),
    accountId: PAYER,
    graphApiKey: null,
    // Null key degrades to step_up; the injected device approves, so the
    // payment flows and the success path is exercised end to end.
    stepUp: { signOnDevice: async () => {} },
    signer: ephemeralSigner(),
  });

  const before = policyEngine.spentInWindow();
  const res = await wrapFetchWithPayment(fetch, x402)(url);
  assert.equal(res.status, 200, "paid request should succeed");
  // The settlement txId must reach the client: the live e2e proof polls
  // HCS for the audit record by this id, and the audit hook learns it
  // from exactly this header.
  const paymentResponse = res.headers.get("payment-response");
  assert.ok(paymentResponse, "200 carries PAYMENT-RESPONSE");
  const settled = JSON.parse(
    Buffer.from(paymentResponse, "base64").toString("utf8")
  ) as { transaction?: string };
  assert.equal(settled.transaction, "0.0.54321@1757280000.000000000");
  const expected = Number(quote(QUERY)) / 1e8;
  assert.ok(
    Math.abs(policyEngine.spentInWindow() - before - expected) < 1e-12,
    `budget should accrue exactly the settled amount (${expected})`
  );
  assert.equal(stub.calls.settle, 1, "exactly one settlement");
});

test("F21: failed settlement accrues nothing", async (t) => {
  const stub = await startStubFacilitator(t, {
    settle: { success: false, errorReason: "facilitator exploded" },
  });
  const url = await startService(t, stub.url);
  const { x402 } = createMandateClient({
    hederaCiphertext: Buffer.from("unused-injected-signer"),
    accountId: PAYER,
    graphApiKey: null,
    stepUp: { signOnDevice: async () => {} },
    signer: ephemeralSigner(),
  });

  const before = policyEngine.spentInWindow();
  const res = await wrapFetchWithPayment(fetch, x402)(url);
  assert.equal(res.status, 402, "failed settlement re-challenges");
  assert.equal(policyEngine.spentInWindow(), before);
  assert.equal(stub.calls.settle, 1);
});

test("F21: deny short-circuits without touching sign/verify/settle", async (t) => {
  const stub = await startStubFacilitator(t);
  const url = await startService(t, stub.url);
  const signs = { signs: 0 };
  const { x402, getLastDecision } = createMandateClient({
    hederaCiphertext: Buffer.from("unused-injected-signer"),
    accountId: PAYER,
    graphApiKey: null,
    stepUp: {
      signOnDevice: async () => {
        throw new Error("no device in test");
      },
    },
    signer: ephemeralSigner(signs),
  });

  const before = policyEngine.spentInWindow();
  await assert.rejects(
    wrapFetchWithPayment(fetch, x402)(url),
    "an aborted payment surfaces as a throw"
  );
  assert.equal(signs.signs, 0, "no signature was created");
  assert.equal(stub.calls.verify, 0, "nothing was verified");
  assert.equal(stub.calls.settle, 0, "nothing was settled");
  assert.equal(policyEngine.spentInWindow(), before);
  assert.equal(getLastDecision()?.decision.verdict, "deny");
});
