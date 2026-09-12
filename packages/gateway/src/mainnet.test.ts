import { test } from "node:test";
import assert from "node:assert/strict";
import { assertMainnetNetwork, assertMainnetChain, assertHederaDisabled } from "./mainnet.ts";
import { validateExactAuthority } from "./agent-exact.ts";

test("mainnet signing rejects all test networks and malformed chain identifiers", () => {
  for (const n of ["eip155:84532", "eip155:296", "hedera:testnet", "hedera:mainnet", null, undefined]) {
    assert.throws(() => assertMainnetNetwork(n), /Mainnet-only/);
  }
  for (const c of [84532, 296, 1, "8453", null]) {
    assert.throws(() => assertMainnetChain(c), /Mainnet-only/);
  }
  assertMainnetNetwork("eip155:8453");
  assertMainnetChain(8453);
  assertMainnetChain(8453n);
  assert.doesNotThrow(() => assertHederaDisabled("hedera:mainnet"));
  assert.throws(() => validateExactAuthority({ network: "eip155:84532" } as never), /Unsupported/);
});
