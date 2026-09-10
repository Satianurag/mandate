import { test } from "node:test";
import assert from "node:assert/strict";
import { assertFreshPresence, buildPresenceChallenge } from "./presence.ts";

const OP = "0x57a2a47Ca22AE52867c5313c4d9ab43070D7C202" as const;

test("presence challenge binds UAID to the operator address, never zero", () => {
  const c = buildPresenceChallenge({
    operator: OP,
    uaid: "uaid:did:...",
    nonce: "n1",
    issuedAt: 1_000,
  });
  assert.equal(c.domain.verifyingContract, OP);
  assert.notEqual(c.domain.verifyingContract, "0x0000000000000000000000000000000000000000");
  assert.equal(c.message.uaid, "uaid:did:...");
});

test("missing, stale, or mismatched presence fails closed", () => {
  const challenge = buildPresenceChallenge({
    operator: OP,
    uaid: "uaid:1",
    nonce: "n1",
    issuedAt: Date.now(),
  });
  const att = {
    challenge,
    signature: ("0x" + "ab".repeat(65)) as `0x${string}`,
    address: OP,
  };
  assertFreshPresence(att, { operator: OP, uaid: "uaid:1" });
  assert.throws(() => assertFreshPresence(null, { operator: OP, uaid: "uaid:1" }), /no presence/);
  assert.throws(
    () => assertFreshPresence(att, { operator: OP, uaid: "uaid:OTHER" }),
    /UAID/
  );
  const stale = {
    ...att,
    challenge: buildPresenceChallenge({
      operator: OP,
      uaid: "uaid:1",
      nonce: "n1",
      issuedAt: Date.now() - 16 * 60 * 1000,
    }),
  };
  assert.throws(() => assertFreshPresence(stale, { operator: OP, uaid: "uaid:1" }), /expired/);
});
