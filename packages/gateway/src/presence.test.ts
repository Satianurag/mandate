import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { assertFreshPresence, buildPresenceChallenge } from "./presence.ts";

const account = privateKeyToAccount(generatePrivateKey());
const expected = { operator: account.address, uaid: "uaid:test-presence" };
async function signed() {
  const challenge = buildPresenceChallenge({ ...expected, nonce: "test-one-time-challenge", issuedAt: Date.now() });
  return { challenge, address: account.address, signature: await account.signTypedData(challenge) };
}
test("presence verifies a real EIP-712 signature against configured operator", async () => {
  await assertFreshPresence(await signed(), expected);
});
test("audit regression: all-zero and arbitrary 65-byte signatures are rejected", async () => {
  const att = await signed();
  for (const byte of ["00", "ab"]) {
    await assert.rejects(assertFreshPresence({ ...att, signature: `0x${byte.repeat(65)}` }, expected), /invalid device signature/);
  }
});
test("presence rejects missing, stale, forged principal, wrong chain and altered typed data", async () => {
  const att = await signed();
  await assert.rejects(assertFreshPresence(null, expected), /no presence/);
  await assert.rejects(assertFreshPresence(att, { ...expected, uaid: "other" }), /UAID/);
  await assert.rejects(assertFreshPresence(att, expected, Date.now() + 16 * 60_000), /expired/);
  await assert.rejects(assertFreshPresence(att, { ...expected, chainId: 1 }), /wrong chain/);
  await assert.rejects(assertFreshPresence({ ...att, challenge: { ...att.challenge,
    message: { ...att.challenge.message, nonce: "changed-after-signing" } } }, expected), /invalid device signature/);
  const other = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(assertFreshPresence({ ...att, signature: await other.signTypedData(att.challenge) }, expected), /invalid device signature/);
  await assert.rejects(assertFreshPresence({ ...att, challenge: { ...att.challenge, types: {} } }, expected), /non-canonical/);
});
