import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTypedDataTrace,
  loadLedgerOriginToken,
  requireLedgerOriginToken,
  signerEthCtorArgs,
} from "./origin-token.ts";

test("signerEthCtorArgs omits originToken when unset", () => {
  const args = signerEthCtorArgs({}, "sess", undefined);
  assert.equal("originToken" in args, false);
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

test("requireLedgerOriginToken fails closed without env or sealed blob", async () => {
  const prev = process.env.LEDGER_ORIGIN_TOKEN;
  delete process.env.LEDGER_ORIGIN_TOKEN;
  try {
    await assert.rejects(requireLedgerOriginToken(), /LEDGER_ORIGIN_TOKEN/);
  } finally {
    if (prev === undefined) delete process.env.LEDGER_ORIGIN_TOKEN;
    else process.env.LEDGER_ORIGIN_TOKEN = prev;
  }
});

test("classifyTypedDataTrace prefers ERC-7730 over legacy fallback", () => {
  const verdict = classifyTypedDataTrace(
    [{ step: "provideContext" }, { step: "steps.signTypedData" }],
    "success",
  );
  assert.equal(verdict, "erc7730");
});
