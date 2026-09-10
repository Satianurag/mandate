import { test } from "node:test";
import assert from "node:assert/strict";
import { findTx, parseSubstreamsHits } from "./substreams-sink.ts";

test("parseSubstreamsHits extracts live-discovered log matches", () => {
  const tx = `0x${"60c8b5d67aa085d5caf2a2d8189579"}${"49687ba25e75491936d637c5bd936d8c18"}`;
  const out = `
INFO x402_hit tx=${tx} address=0x4020074e9df2ce1dee5a9c1b5c3f541d02a10003 block=123
`;
  const hits = parseSubstreamsHits(out);
  assert.equal(hits.length, 1);
  assert.ok(findTx(hits, tx));
});
