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
import { Journal } from "./journal.ts";
import { testApproval } from "../test-support/approval.ts";
const journal = new Journal(":memory:");
const spent = () => journal.mandates().reduce((sum, m) => sum + Number(journal.totals(m.id, 3600000).spent) / 1e8, 0);
import { createMandateClient } from "./client.ts";
import { startStubFacilitator } from "../test-support/facilitator.ts";
import { quote, buildService } from "../../service/src/index.ts";

const PAYER = "0.0.54321";
const PAY_TO = "0.0.5005";
const QUERY = "{ agents(first: 5) { id } }";

async function startService(t: { after: (fn: () => void) => void }, facilitatorUrl: string) {
  const server = await buildService({
    payTo: PAY_TO,
    facilitatorUrl,
    port: 0,
    host: "127.0.0.1",
    journalPath: ":memory:",
    fetchRows: async () => [
      {
        id: "0xagent0fixture",
        agentId: "1",
        agentWallet: "0x0000000000000000000000000000000000000001",
        totalFeedback: "3",
        sampleMean: 90,
      },
    ],
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
  const { x402 } = createMandateClient({ resourceUrl: url, journal,
    hederaCiphertext: Buffer.from("unused-injected-signer"),
    accountId: PAYER,
    graphApiKey: null,
    // Null key degrades to step_up; the injected device approves, so the
    // payment flows and the success path is exercised end to end.
    stepUp: testApproval(journal),
    signer: ephemeralSigner(),
  });

  const before = spent();
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
    Math.abs(spent() - before - expected) < 1e-12,
    `budget should accrue exactly the settled amount (${expected})`
  );
  assert.equal(stub.calls.settle, 1, "exactly one settlement");
});

test("F21: failed settlement accrues nothing", async (t) => {
  const stub = await startStubFacilitator(t, {
    settle: { success: false, errorReason: "facilitator exploded" },
  });
  const url = await startService(t, stub.url);
  const { x402 } = createMandateClient({ resourceUrl: url, journal,
    hederaCiphertext: Buffer.from("unused-injected-signer"),
    accountId: PAYER,
    graphApiKey: null,
    stepUp: testApproval(journal),
    signer: ephemeralSigner(),
  });

  const before = spent();
  const res = await wrapFetchWithPayment(fetch, x402)(url);
  assert.equal(res.status, 402, "failed settlement re-challenges");
  assert.equal(spent(), before);
  assert.equal(stub.calls.settle, 1);
});

test("F21: deny short-circuits without touching sign/verify/settle", async (t) => {
  const stub = await startStubFacilitator(t);
  const url = await startService(t, stub.url);
  const signs = { signs: 0 };
  const { x402, getLastDecision } = createMandateClient({ resourceUrl: url, journal,
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

  const before = spent();
  await assert.rejects(
    wrapFetchWithPayment(fetch, x402)(url),
    "an aborted payment surfaces as a throw"
  );
  assert.equal(signs.signs, 0, "no signature was created");
  assert.equal(stub.calls.verify, 0, "nothing was verified");
  assert.equal(stub.calls.settle, 0, "nothing was settled");
  assert.equal(spent(), before);
  assert.equal(getLastDecision()?.decision.verdict, "deny");
});


test("audit regression: analytics failure happens before verify or settlement", async (t) => {
  const stub = await startStubFacilitator(t);
  const server = await buildService({ payTo: PAY_TO, facilitatorUrl: stub.url,
    port: 0, host: "127.0.0.1", journalPath: ":memory:",
    fetchRows: async () => { throw new Error("Upstream Graph unavailable"); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/analytics?q=${encodeURIComponent(QUERY)}`;
  const { x402 } = createMandateClient({ resourceUrl: url, journal, hederaCiphertext: Buffer.from("not-used"), accountId: PAYER,
    graphApiKey: null, stepUp: testApproval(journal), signer: ephemeralSigner() });
  const response = await wrapFetchWithPayment(fetch, x402)(url);
  assert.equal(response.status, 503);
  assert.equal(stub.calls.verify, 0, "even an upfront settlement flow has not started");
  assert.equal(stub.calls.settle, 0, "Graph failure cannot charge the client");
  assert.equal((await response.json() as { paymentCommitted: boolean }).paymentCommitted, false);
});

test("audit regression: reusing a client accounts for every payment response", async (t) => {
  const stub = await startStubFacilitator(t), url = await startService(t, stub.url);
  const { x402 } = createMandateClient({ resourceUrl: url, journal, hederaCiphertext: Buffer.from("not-used"), accountId: PAYER,
    graphApiKey: null, stepUp: testApproval(journal), signer: ephemeralSigner() });
  const paidFetch = wrapFetchWithPayment(fetch, x402), before = spent();
  assert.equal((await paidFetch(url)).status, 200);
  assert.equal((await paidFetch(url)).status, 200);
  assert.ok(Math.abs(spent() - before - 2 * Number(quote(QUERY))/1e8) < 1e-12);
});
