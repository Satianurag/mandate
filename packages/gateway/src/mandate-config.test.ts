import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMandateFile } from "./mandate-config.ts";

const GOOD = `
version: 2
network: eip155:8453
rpcUrl: https://mainnet.base.org
serviceUrl: http://127.0.0.1:8405/analytics
ceilingBaseUnits: "5000000"
salt: "0x${"ab".repeat(32)}"
receiver: "0x000000000000000000000000000000000000dEaD"
sessionKey: mandate-session
asset: "0x0000000000000000000000000000000000000001"
operatorAddress: "0x0000000000000000000000000000000000000002"
receiverAuthorizer: "0x0000000000000000000000000000000000000003"
withdrawDelay: 86400
expiresAt: "2030-01-01T00:00:00.000Z"
perCallBaseUnits: "50000"
windowBaseUnits: "100000"
windowMs: 3600000
storageRoot: ./state/mandate
researchSource:
  provider: the-graph
  chain: bsc-chapel
  deployment: BTjind17gmRZ6YhT9peaCM13SvWuqztsmqyfjpntbg3Z
`;

test("parses a valid mandate file and checksums the receiver", () => {
  const m = parseMandateFile(GOOD);
  assert.equal(m.version, 2);
  assert.equal(m.ceilingBaseUnits, "5000000");
  assert.equal(m.receiver, "0x000000000000000000000000000000000000dEaD");
  assert.equal(m.derivationPath, "44'/60'/0'/0/0");
  assert.equal(m.researchSource?.chain, "bsc-chapel");
  assert.equal(m.researchSource?.deployment, "BTjind17gmRZ6YhT9peaCM13SvWuqztsmqyfjpntbg3Z");
});

test("rejects wrong version, network, and malformed fields by name", () => {
  assert.throws(() => parseMandateFile(GOOD.replace("version: 2", "version: 3")), /"version"/);
  assert.throws(() => parseMandateFile(GOOD.replace("eip155:8453", "eip155:1")), /"network"/);
  assert.throws(() => parseMandateFile(GOOD.replace('"5000000"', '"5.0"')), /"ceilingBaseUnits"/);
  assert.throws(() => parseMandateFile(GOOD.replace("ab".repeat(32), "ab")), /"salt"/);
  assert.throws(() => parseMandateFile(GOOD.replace("0x000000000000000000000000000000000000dEaD", "nope")), /"receiver"/);
  assert.throws(() => parseMandateFile(GOOD.replace("https://mainnet.base.org", "gopher://x")), /"rpcUrl"/);
  assert.throws(() => parseMandateFile("[]"), /mapping/);
  assert.throws(() => parseMandateFile(":\n: bad"), /invalid YAML/);
});

test("legacy configuration is explicitly rejected rather than silently adding authority", () => {
  assert.throws(() => parseMandateFile(GOOD.replace("version: 2", "version: 1")), /legacy v1/);
  assert.throws(() => parseMandateFile(GOOD + "\nunrecognizedLimit: 100\n"), /unrecognizedLimit/);
});


test("legacy v2 without a research source remains readable for recovery", () => {
  const legacy = parseMandateFile(GOOD.replace(/researchSource:[\s\S]*$/, ""));
  assert.equal(legacy.researchSource, undefined);
});
