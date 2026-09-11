/**
 * Hedera amount normalisation — HBAR and stock Circle HTS USDC.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HBAR_ASSET_ID } from "@x402/hedera";
import { CIRCLE_HEDERA_TESTNET_USDC_HTS } from "./facilitators.ts";
import { DEFAULT_HTS_DECIMALS, normaliseAmount } from "./hedera.ts";

test("HBAR divides by 1e8 tinybars", () => {
  const { amount, symbol } = normaliseAmount({
    scheme: "exact",
    network: "hedera:testnet",
    asset: HBAR_ASSET_ID,
    amount: "3700000",
    payTo: "0.0.5005",
    extra: {},
    maxTimeoutSeconds: 60,
  });
  assert.equal(symbol, "HBAR");
  assert.equal(amount, 0.037);
});

test("Circle testnet USDC is 6 decimals without a caller table", () => {
  assert.equal(DEFAULT_HTS_DECIMALS[CIRCLE_HEDERA_TESTNET_USDC_HTS], 6);
  const { amount, symbol } = normaliseAmount({
    scheme: "exact",
    network: "hedera:testnet",
    asset: CIRCLE_HEDERA_TESTNET_USDC_HTS,
    amount: "10000",
    payTo: "0.0.5005",
    extra: {},
    maxTimeoutSeconds: 60,
  });
  assert.equal(symbol, CIRCLE_HEDERA_TESTNET_USDC_HTS);
  assert.equal(amount, 0.01);
});

test("unknown HTS asset is a loud throw, never a guessed decimal", () => {
  assert.throws(
    () =>
      normaliseAmount({
        scheme: "exact",
        network: "hedera:testnet",
        asset: "0.0.99999999",
        amount: "1",
        payTo: "0.0.5005",
        extra: {},
    maxTimeoutSeconds: 60,
      }),
    /unknown asset/
  );
});

test("Base Sepolia USDC is 6 decimals on eip155:84532", () => {
  const { amount, symbol } = normaliseAmount({
    scheme: "exact",
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    amount: "42",
    payTo: "0x301672eEf23F0e5f165cfba26762702F20A74430",
    extra: {},
    maxTimeoutSeconds: 300,
  });
  assert.equal(symbol, "USDC");
  assert.equal(amount, 0.000042);
});
