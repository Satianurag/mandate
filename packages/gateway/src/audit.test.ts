import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRecord, buildMandateRecord } from "./audit.ts";

const reputation = {
  registered: true,
  feedbackCount: 10,
  meanScore: 0.9,
  revokedCount: 0,
  validationCount: 0,
  chainsQueried: 9,
  chainsReachable: 8,
  chainsFailed: ["eip155:1"],
};

test("buildRecord carries verdict, coverage, txId, and a trace hash", () => {
  const record = buildRecord(
    {
      origin: "http://127.0.0.1:8403",
      requirements: {
        scheme: "exact",
        network: "hedera:testnet",
        asset: "0.0.0",
        amount: "2000000",
        payTo: "0.0.5005",
        maxTimeoutSeconds: 60,
        extra: { feePayer: "0.0.7162784" },
      },
      normalisedAmount: 0.02,
      assetSymbol: "HBAR",
    },
    { verdict: "allow", reason: "under gate, reputable", trace: ["t1"], reputation },
    { success: true, transactionId: "0.0.5005@1.1" }
  );
  assert.equal(record.v, 1);
  assert.equal(record.verdict, "allow");
  assert.equal(record.coverage, "8/9");
  assert.deepEqual(record.chainsFailed, ["eip155:1"]);
  assert.equal(record.txId, "0.0.5005@1.1");
  assert.equal(record.traceHash.length, 64);
});

test("buildMandateRecord states the mandate truthfully: stream, taps, 0/0 coverage", () => {
  const record = buildMandateRecord({
    channelId: "0xchannel",
    salt: "0xsalt",
    payer: "0xpayer",
    receiver: "0xreceiver",
    ceilingBaseUnits: "5000000",
    cumulativeBaseUnits: "30000",
    calls: 3,
    taps: 1,
    serviceUrl: "http://127.0.0.1:8405/analytics",
  });
  assert.equal(record.verdict, "allow");
  assert.equal(record.asset, "USDC");
  assert.equal(record.amount, 0.03);
  assert.equal(record.coverage, "0/0");
  assert.equal(record.score, null);
  assert.match(record.reason, /3 calls, 1 tap\(s\)/);
  assert.match(record.reason, /\$0\.03 of \$5\.00 ceiling/);
  assert.match(record.reason, /0xchannel/);
  assert.equal(record.txId, undefined);
  assert.equal(record.traceHash.length, 64);
});
