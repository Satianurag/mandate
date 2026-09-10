import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPayTo } from "./resolve-pay-to.mjs";

test("env merchant wins when it differs from the payer", () => {
  assert.equal(
    pickPayTo({ envPayTo: "0.0.2", filePayTo: "0.0.3", payer: "0.0.1" }),
    "0.0.2"
  );
});

test("file merchant is used when env is a self-transfer", () => {
  assert.equal(
    pickPayTo({ envPayTo: "0.0.1", filePayTo: "0.0.9", payer: "0.0.1" }),
    "0.0.9"
  );
});

test("self-transfer env and empty file is rejected", () => {
  assert.equal(pickPayTo({ envPayTo: "0.0.1", filePayTo: "", payer: "0.0.1" }), null);
  assert.equal(pickPayTo({ envPayTo: "0.0.1", filePayTo: "0.0.1", payer: "0.0.1" }), null);
});
