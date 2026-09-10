/**
 * Hermetic checks for the stock Hedera exact resource server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CIRCLE_HEDERA_TESTNET_USDC_HTS } from "../../gateway/src/facilitators.ts";
import { quote, SERVICE_NETWORK } from "./index.ts";

test("resource server is stock exact@hedera:testnet", () => {
  assert.equal(SERVICE_NETWORK, "hedera:testnet");
  assert.equal(CIRCLE_HEDERA_TESTNET_USDC_HTS, "0.0.429274");
});

test("HBAR quote meters by nesting and fields", () => {
  const small = quote("{ a { id } }");
  const large = quote("{ agents { id feedbacks { value revoked } validations { response } } }");
  assert.ok(large > small, `${large} should exceed ${small}`);
  assert.equal(typeof small, "bigint");
});
