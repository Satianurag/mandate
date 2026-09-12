import { test } from "node:test";
import assert from "node:assert/strict";
import { hashTypedData } from "viem";
import { joinSignature, withExplicitEip712DomainType } from "./dmksigner.ts";

// joinSignature is pure and load-bearing (a malformed join is a signature
// the facilitator rejects, or worse, one that verifies for wrong bytes):
// pinned here. Device I/O itself is proven live by `npm run mandate:open`.

test("joinSignature joins r‖s‖v into a 65-byte 0x signature", () => {
  // Built programmatically: a 64-hex literal in source would trip the
  // committed-key-material check in verify.sh.
  const sig = joinSignature({ r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, v: 27 });
  assert.equal(sig, `0x${"11".repeat(32)}${"22".repeat(32)}1b`);
});

test("joinSignature pads short r/s and normalizes 0/1-style v to 27/28", () => {
  const sig0 = joinSignature({ r: "0x1", s: "0x2", v: 0 });
  assert.equal(sig0.length, 2 + 64 + 64 + 2);
  assert.ok(sig0.startsWith("0x0000"));
  assert.ok(sig0.endsWith("1b"));
  const sig1 = joinSignature({ r: "0x1", s: "0x2", v: 1 });
  assert.ok(sig1.endsWith("1c"));
  const already = joinSignature({
    r: `0x${"11".repeat(32)}`,
    s: `0x${"22".repeat(32)}`,
    v: 27,
  });
  assert.ok(already.endsWith("1b"));
});


test("withExplicitEip712DomainType adds Ledger-compatible canonical domain schema without mutation", () => {
  const original = {
    domain: { name: "USDC", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }] } as Record<string, unknown>,
    primaryType: "ReceiveWithAuthorization",
    message: { from: "0x0000000000000000000000000000000000000001" },
  };
  const normalized = withExplicitEip712DomainType(original);
  assert.notEqual(normalized, original);
  assert.equal(original.types.EIP712Domain, undefined);
  assert.deepEqual(normalized.types.EIP712Domain, [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ]);
});

test("withExplicitEip712DomainType preserves an explicit caller domain schema", () => {
  const domain = [{ name: "chainId", type: "uint256" }];
  const original = { domain: { chainId: 8453 }, types: { EIP712Domain: domain }, primaryType: "Ping", message: {} };
  const normalized = withExplicitEip712DomainType(original);
  assert.deepEqual(normalized.types.EIP712Domain, domain);
});


test("Ledger domain normalization preserves the exact EIP-712 digest", () => {
  const original = {
    domain: { name: "USDC", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    } as Record<string, unknown>,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: "0x57a2a47Ca22AE52867c5313c4d9ab43070D7C202",
      to: "0x57a2a47Ca22AE52867c5313c4d9ab43070D7C202",
      value: 1n,
      validAfter: 1n,
      validBefore: 2n,
      nonce: `0x${"11".repeat(32)}`,
    },
  };
  const normalized = withExplicitEip712DomainType(original);
  assert.equal(hashTypedData(original as any), hashTypedData(normalized as any));
});
