import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTypedDataTrace,
  ledgerFundingReadiness,
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

test("ledgerFundingReadiness reports test CAL without treating it as a partner token", async () => {
  const prevToken = process.env.LEDGER_ORIGIN_TOKEN;
  const prevCal = process.env.MANDATE_LEDGER_TEST_CAL_URL;
  delete process.env.LEDGER_ORIGIN_TOKEN;
  process.env.MANDATE_LEDGER_TEST_CAL_URL = "http://127.0.0.1:8427";
  try {
    const ready = await ledgerFundingReadiness();
    assert.equal(ready.originTokenPresent, false);
    assert.equal(ready.testCal, true);
    assert.equal(ready.canClearSign, true);
    assert.equal(ready.path, "ledger-dev-test-cal");
  } finally {
    if (prevToken === undefined) delete process.env.LEDGER_ORIGIN_TOKEN;
    else process.env.LEDGER_ORIGIN_TOKEN = prevToken;
    if (prevCal === undefined) delete process.env.MANDATE_LEDGER_TEST_CAL_URL;
    else process.env.MANDATE_LEDGER_TEST_CAL_URL = prevCal;
  }
});

test("classifyTypedDataTrace prefers ERC-7730 over legacy fallback", () => {
  const verdict = classifyTypedDataTrace(
    [{ step: "provideContext" }, { step: "steps.signTypedData" }],
    "success",
  );
  assert.equal(verdict, "erc7730");
});
