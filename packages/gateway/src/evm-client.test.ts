/**
 * Stock EVM x402 client wiring — hermetic. Live Graph/upto payments are
 * `npm run e2e:graph-x402` / `npm run e2e:upto`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClientEvmSigner } from "@x402/evm";
import { createEvmX402Client } from "./evm-client.ts";
import { createMandateEvmClient } from "./client.ts";

const stub: ClientEvmSigner = {
  address: "0x57a2a47Ca22AE52867c5313c4d9ab43070D7C202",
  signTypedData: async () => (`0x${"11".repeat(65)}` as `0x${string}`),
};

test("createEvmX402Client builds without an env private key", () => {
  const client = createEvmX402Client({
    signer: stub,
    rpcUrl: "http://127.0.0.1:1",
    chainId: 84532,
  });
  assert.equal(typeof client.onBeforePaymentCreation, "function");
});

test("createMandateEvmClient attaches policy hooks", () => {
  const { x402, getLastDecision } = createMandateEvmClient({
    evmSigner: stub,
    rpcUrl: "http://127.0.0.1:1",
    hederaCiphertext: Buffer.from("unused"),
    accountId: "0.0.1",
    graphApiKey: null,
  });
  assert.equal(typeof x402.onBeforePaymentCreation, "function");
  assert.equal(getLastDecision(), undefined);
});
