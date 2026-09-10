import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTypedDataTrace,
  loadLedgerOriginToken,
  signerEthCtorArgs,
  uniqueTraceSteps,
} from "./origin-token.ts";

test("signerEthCtorArgs omits originToken when unset", () => {
  const args = signerEthCtorArgs({}, "sess", undefined);
  assert.equal("originToken" in args, false);
});

test("signerEthCtorArgs omits blank originToken", () => {
  const args = signerEthCtorArgs({}, "sess", "  ");
  assert.equal("originToken" in args, false);
});

test("signerEthCtorArgs passes originToken when set", () => {
  const args = signerEthCtorArgs({}, "sess", "  partner-token  ");
  assert.equal(args.originToken, "partner-token");
});

test("loadLedgerOriginToken reads trimmed LEDGER_ORIGIN_TOKEN", async () => {
  const prev = process.env.LEDGER_ORIGIN_TOKEN;
  process.env.LEDGER_ORIGIN_TOKEN = "  partner-token  ";
  try {
    assert.equal(await loadLedgerOriginToken(), "partner-token");
  } finally {
    if (prev === undefined) delete process.env.LEDGER_ORIGIN_TOKEN;
    else process.env.LEDGER_ORIGIN_TOKEN = prev;
  }
});

test("loadLedgerOriginToken is undefined without env or sealed blob", async () => {
  const prev = process.env.LEDGER_ORIGIN_TOKEN;
  delete process.env.LEDGER_ORIGIN_TOKEN;
  try {
    assert.equal(await loadLedgerOriginToken(), undefined);
  } finally {
    if (prev !== undefined) process.env.LEDGER_ORIGIN_TOKEN = prev;
  }
});

test("classifyTypedDataTrace: CAL filters + provide is erc7730", () => {
  assert.equal(
    classifyTypedDataTrace(
      [
        { step: "signer.eth.steps.buildContext" },
        { step: "signer.eth.steps.provideContext" },
        { step: "signer.eth.steps.signTypedData" },
        { step: "signer.eth.steps.detectBlindSigning" },
      ],
      "success"
    ),
    "erc7730"
  );
});

test("classifyTypedDataTrace: provide without CAL filters is clear-basic", () => {
  assert.equal(
    classifyTypedDataTrace([
      { step: "signer.eth.steps.buildContext" },
      { step: "signer.eth.steps.provideContext" },
      { step: "signer.eth.steps.signTypedData" },
    ]),
    "clear-basic"
  );
});

test("classifyTypedDataTrace: CAL error + provide is clear-basic", () => {
  assert.equal(
    classifyTypedDataTrace(
      [
        { step: "signer.eth.steps.provideContext" },
        { step: "signer.eth.steps.signTypedData" },
      ],
      "error"
    ),
    "clear-basic"
  );
});

test("classifyTypedDataTrace: legacy fallback beats a failed provide", () => {
  assert.equal(
    classifyTypedDataTrace([
      { step: "signer.eth.steps.buildContext" },
      { step: "signer.eth.steps.provideContext" },
      { step: "signer.eth.steps.signTypedDataLegacy" },
    ]),
    "legacy-eip712"
  );
});

test("classifyTypedDataTrace: legacy without provide is legacy-eip712", () => {
  assert.equal(
    classifyTypedDataTrace([{ step: "signer.eth.steps.signTypedDataLegacy" }]),
    "legacy-eip712"
  );
});

test("classifyTypedDataTrace: blind reporter without provide is blind", () => {
  assert.equal(
    classifyTypedDataTrace([{ step: "signer.eth.steps.detectBlindSigning" }]),
    "blind"
  );
});

test("classifyTypedDataTrace: empty trace is unknown", () => {
  assert.equal(classifyTypedDataTrace([]), "unknown");
});

test("uniqueTraceSteps de-dupes in order", () => {
  assert.deepEqual(
    uniqueTraceSteps([
      { step: "a" },
      { step: "a" },
      { step: "b" },
      {},
      { step: "a" },
    ]),
    ["a", "b"]
  );
});
