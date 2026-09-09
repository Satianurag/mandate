/**
 * End-to-end: a real 402 from our own service, through the real policy engine.
 *
 * No device and no Graph key, which is the point -- this test exists to prove
 * the FAIL-SAFE chain. With reputation unavailable the counterparty must be
 * treated as unregistered, which escalates, and with no device attached the
 * escalation must resolve to deny. At no point may a missing dependency
 * produce an allow.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { decide } from "./index.ts";
import { normaliseAmount } from "./hedera.ts";
import type { PaymentRequiredBody } from "./types.ts";

const PORT = 8409;

function startService(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", new URL("../../service/src/index.ts", import.meta.url).pathname],
    { env: { ...process.env, SERVICE_PORT: String(PORT) }, stdio: "ignore" }
  );
  return new Promise((resolve) => setTimeout(() => resolve(child), 1500));
}

test("live 402 -> policy engine -> fail-safe deny", async (t) => {
  const svc = await startService();
  t.after(() => svc.kill());

  const res = await fetch(
    `http://localhost:${PORT}/analytics?q=${encodeURIComponent("{ agents { id } }")}`
  );
  assert.equal(res.status, 402, "service must challenge for payment");

  const challenge = (await res.json()) as PaymentRequiredBody;
  const req = challenge.accepts[0];
  assert.ok(req, "challenge carries requirements");
  assert.equal(req.scheme, "exact");
  assert.equal(req.network, "hedera:testnet");
  assert.ok(req.extra.feePayer, "feePayer present -- never hardcoded, always read from the challenge");

  // tinybar normalisation: getting this wrong by a decimal slips past the ceiling
  const { amount, symbol } = normaliseAmount(req);
  assert.equal(symbol, "HBAR");
  assert.equal(amount, Number(req.amount) / 1e8);

  // The invariant.
  const out = await decide(`http://localhost:${PORT}`, challenge, "deliberately-invalid-key");
  assert.notEqual(out.decision.verdict, "allow", "a missing Graph key must never fail open");
  assert.equal(out.decision.verdict, "deny", "no device -> escalation resolves to deny");
  assert.ok(
    out.decision.trace.includes("reputation:unregistered"),
    "unreachable reputation must degrade to unregistered, not to trusted"
  );
});

test("complexity metering prices a bigger query higher", async (t) => {
  const svc = await startService();
  t.after(() => svc.kill());

  const price = async (q: string) => {
    const r = await fetch(`http://localhost:${PORT}/analytics?q=${encodeURIComponent(q)}`);
    const b = (await r.json()) as PaymentRequiredBody;
    return BigInt(b.accepts[0]!.amount);
  };

  const small = await price("{ a { id } }");
  const large = await price("{ agents { id feedbacks { value revoked } validations { response } } }");
  assert.ok(large > small, `per-call metering: ${large} should exceed ${small}`);
});
