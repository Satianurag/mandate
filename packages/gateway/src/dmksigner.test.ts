import { test } from "node:test";
import assert from "node:assert/strict";
import { hashTypedData } from "viem";
import { joinSignature, withExplicitEip712DomainType } from "./dmksigner.ts";

test("joinSignature joins r‖s‖v into a 65-byte 0x signature", () => {
  const sig = joinSignature({ r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, v: 27 });
  assert.equal(sig, `0x${"11".repeat(32)}${"22".repeat(32)}1b`);
});

test("withExplicitEip712DomainType preserves the exact EIP-712 digest", () => {
  const original = {
    domain: { name: "USDC", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }] } as Record<string, unknown>,
    primaryType: "ReceiveWithAuthorization",
    message: { from: "0x0000000000000000000000000000000000000001" },
  };
  const normalized = withExplicitEip712DomainType(original);
  assert.equal(
    hashTypedData(normalized as never),
    hashTypedData(original as never),
  );
});
