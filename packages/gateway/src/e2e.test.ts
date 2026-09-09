/**
 * End-to-end: a real 402 from our own service, through the real policy engine.
 *
 * No device and no Graph key, which is the point -- these tests exist to
 * prove the FAIL-SAFE chain. With reputation unavailable the counterparty
 * must be treated as unregistered, which escalates, and with no device
 * attached the escalation must resolve to deny. At no point may a missing
 * dependency produce an allow.
 *
 * The deny test runs against a SPAWNED service (cross-process, like
 * production); the rejection-shape tests run the same server in-process.
 * Both use the stub facilitator: nothing here touches the chain.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyFetch } from "./index.ts";
import { decide } from "./client.ts";
import { normaliseAmount } from "./hedera.ts";
import { startStubFacilitator } from "./facilitator-stub.ts";
import { buildService } from "../../service/src/index.ts";
import type { PaymentRequired } from "./types.ts";

const PORT = 8409;

function startSpawnedService(facilitatorUrl: string): Promise<ChildProcess> {
  // Hermetic: the suite must pass with ZERO ambient env (README's one-liner).
  // Explicit CLI flags pin the test double; production resolves live.
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      new URL("../../service/src/index.ts", import.meta.url).pathname,
      "--pay-to",
      "0.0.5005",
    ],
    {
      env: {
        ...process.env,
        SERVICE_PORT: String(PORT),
        MANDATE_FACILITATOR_URL: facilitatorUrl,
      },
      stdio: "ignore",
    }
  );
  return new Promise((resolve) => setTimeout(() => resolve(child), 1500));
}

async function startInProcessService(
  t: { after: (fn: () => void) => void },
  facilitatorUrl: string
): Promise<string> {
  const server = await buildService({
    payTo: "0.0.5005",
    facilitatorUrl,
    port: 0,
    host: "127.0.0.1",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("live 402 -> proxy -> fail-safe deny", async (t) => {
  const stub = await startStubFacilitator(t);
  const svc = await startSpawnedService(stub.url);
  t.after(() => svc.kill());
  const base = `http://localhost:${PORT}`;

  // v2 rides the offer in the PAYMENT-REQUIRED header (base64 JSON), not
  // the body -- same helper the mandate-service suite uses.
  const readChallenge = (res: Response): PaymentRequired => {
    const header = res.headers.get("payment-required");
    assert.ok(header, "402 must carry PAYMENT-REQUIRED");
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentRequired;
  };

  const probe = await fetch(`${base}/analytics?q=${encodeURIComponent("{ agents { id } }")}`);
  assert.equal(probe.status, 402, "service must challenge for payment");
  const challenge = readChallenge(probe);
  const req = challenge.accepts[0];
  assert.ok(req, "challenge carries requirements");
  assert.equal(req.scheme, "exact");
  assert.equal(req.network, "hedera:testnet");
  assert.equal(
    (req.extra as { feePayer?: string }).feePayer,
    "0.0.7162784",
    "feePayer merged from the facilitator advertisement -- never hardcoded, never pinned"
  );

  // tinybar normalisation: getting this wrong by a decimal slips past the ceiling
  const { amount, symbol } = normaliseAmount(req);
  assert.equal(symbol, "HBAR");
  assert.equal(amount, Number(req.amount) / 1e8);

  // The invariant, through the real proxy. Null key = reputation
  // unavailable; denying device = no human consent. Neither may produce
  // an allow. The key file is FAKE BYTES -- a deny must never unseal it,
  // and a 403 (rather than a 500 from a failed unseal) proves it never did.
  const dir = await mkdtemp(join(tmpdir(), "mandate-e2e-"));
  t.after(() => void rm(dir, { recursive: true, force: true }));
  const fakeKey = join(dir, "hedera.enc");
  await writeFile(fakeKey, "fake-bytes-never-unsealed-on-deny");
  const savedAccount = process.env.MANDATE_HEDERA_ACCOUNT_ID;
  const savedKey = process.env.MANDATE_HEDERA_KEY_ENC;
  process.env.MANDATE_HEDERA_ACCOUNT_ID = "0.0.54321";
  process.env.MANDATE_HEDERA_KEY_ENC = fakeKey;
  t.after(() => {
    if (savedAccount === undefined) delete process.env.MANDATE_HEDERA_ACCOUNT_ID;
    else process.env.MANDATE_HEDERA_ACCOUNT_ID = savedAccount;
    if (savedKey === undefined) delete process.env.MANDATE_HEDERA_KEY_ENC;
    else process.env.MANDATE_HEDERA_KEY_ENC = savedKey;
  });

  const denied = await proxyFetch(`${base}/analytics?q=${encodeURIComponent("{ agents { id } }")}`, undefined, {
    stepUp: {
      signOnDevice: async () => {
        throw new Error("no device in test");
      },
    },
  });
  assert.equal(denied.status, 403, "no device -> escalation resolves to deny");
  const body = (await denied.json()) as { error?: string; trace?: string[] };
  assert.ok(body.error, "the 403 carries the policy reason");
  assert.ok(
    body.trace?.includes("reputation:unregistered"),
    "unreachable reputation must degrade to unregistered, not to trusted"
  );
  assert.equal(stub.calls.verify, 0, "a deny verifies nothing");
  assert.equal(stub.calls.settle, 0, "a deny settles nothing");
});

test("decide() judges the selected requirements directly", async () => {
  const out = await decide(
    "http://127.0.0.1:8403",
    {
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.0",
      amount: "100000",
      payTo: "0.0.5005",
      maxTimeoutSeconds: 60,
      extra: { feePayer: "0.0.7162784" },
    },
    null,
    {
      stepUp: {
        signOnDevice: async () => {
          throw new Error("no device in test");
        },
      },
    }
  );
  assert.equal(out.decision.verdict, "deny");
});

test("service re-challenges a malformed PAYMENT-SIGNATURE", async (t) => {
  const stub = await startStubFacilitator(t);
  const base = await startInProcessService(t, stub.url);

  const res = await fetch(`${base}/analytics`, {
    headers: { "PAYMENT-SIGNATURE": Buffer.from("not-valid-json").toString("base64") },
  });
  assert.equal(res.status, 402, "malformed payload is unpaid, not a crash");
  assert.equal(stub.calls.verify, 0, "garbage never reaches the facilitator");
});

test("service re-challenges payment that fails facilitator verify", async (t) => {
  const stub = await startStubFacilitator(t, {
    verify: { isValid: false, invalidReason: "bad signature" },
  });
  const base = await startInProcessService(t, stub.url);

  const probe = await fetch(`${base}/analytics`);
  const header = probe.headers.get("payment-required");
  assert.ok(header, "402 must carry PAYMENT-REQUIRED");
  const challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentRequired;
  const bogus = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: challenge.accepts[0]!,
      payload: { transaction: "deadbeef" },
    })
  ).toString("base64");

  const res = await fetch(`${base}/analytics`, {
    headers: { "PAYMENT-SIGNATURE": bogus },
  });
  assert.equal(res.status, 402, "invalid payment must not serve analytics");
  assert.equal(stub.calls.verify, 1, "rejection came from the facilitator");
  assert.equal(stub.calls.settle, 0, "rejected payment is never settled");
  const rechallenge = res.headers.get("payment-required");
  assert.ok(rechallenge, "re-challenge re-issues requirements in PAYMENT-REQUIRED");
  const reBody = JSON.parse(Buffer.from(rechallenge, "base64").toString("utf8")) as PaymentRequired;
  assert.ok(reBody.accepts?.length, "re-challenge carries requirements");
  assert.ok(reBody.error, "response explains why payment was rejected");
});

test("complexity metering prices a bigger query higher", async (t) => {
  const stub = await startStubFacilitator(t);
  const base = await startInProcessService(t, stub.url);

  const price = async (q: string) => {
    const r = await fetch(`${base}/analytics?q=${encodeURIComponent(q)}`);
    const h = r.headers.get("payment-required");
    assert.ok(h, "402 must carry PAYMENT-REQUIRED");
    const b = JSON.parse(Buffer.from(h, "base64").toString("utf8")) as PaymentRequired;
    return BigInt(b.accepts[0]!.amount);
  };

  const small = await price("{ a { id } }");
  const large = await price("{ agents { id feedbacks { value revoked } validations { response } } }");
  assert.ok(large > small, `per-call metering: ${large} should exceed ${small}`);
});
