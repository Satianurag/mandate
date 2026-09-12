import { test } from "node:test";
import assert from "node:assert/strict";
import { HBAR_ASSET_ID } from "@x402/hedera";
import { CIRCLE_HEDERA_MAINNET_USDC_HTS } from "./facilitators.ts";
import { DEFAULT_HTS_DECIMALS, normaliseAmount } from "./hedera.ts";

test("HBAR divides by 1e8 tinybars", () => {
  const { amount, symbol } = normaliseAmount({
    scheme: "exact",
    network: "hedera:mainnet",
    asset: HBAR_ASSET_ID,
    amount: "3700000",
    payTo: "0.0.5005",
    extra: {},
    maxTimeoutSeconds: 60,
  });
  assert.equal(symbol, "HBAR");
  assert.equal(amount, 0.037);
});

test("Circle mainnet USDC is 6 decimals", () => {
  assert.equal(DEFAULT_HTS_DECIMALS[CIRCLE_HEDERA_MAINNET_USDC_HTS], 6);
  const { amount } = normaliseAmount({
    scheme: "exact",
    network: "hedera:mainnet",
    asset: CIRCLE_HEDERA_MAINNET_USDC_HTS,
    amount: "10000",
    payTo: "0.0.5005",
    extra: {},
    maxTimeoutSeconds: 60,
  });
  assert.equal(amount, 0.01);
});

test("unknown HTS asset is a loud throw", () => {
  assert.throws(
    () => normaliseAmount({
      scheme: "exact",
      network: "hedera:mainnet",
      asset: "0.0.99999999",
      amount: "1",
      payTo: "0.0.5005",
      extra: {},
      maxTimeoutSeconds: 60,
    }),
    /unknown asset/,
  );
});
