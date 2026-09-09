import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMandateFile } from "./mandate-config.ts";

const GOOD = `
version: 1
network: eip155:84532
rpcUrl: https://sepolia.base.org
serviceUrl: http://127.0.0.1:8405/analytics
ceilingBaseUnits: "5000000"
salt: "0x${"ab".repeat(32)}"
receiver: "0x000000000000000000000000000000000000dEaD"
sessionKey: mandate-session
storageRoot: ./state/mandate
`;

test("parses a valid mandate file and checksums the receiver", () => {
  const m = parseMandateFile(GOOD);
  assert.equal(m.version, 1);
  assert.equal(m.ceilingBaseUnits, "5000000");
  assert.equal(m.receiver, "0x000000000000000000000000000000000000dEaD");
  assert.equal(m.derivationPath, "44'/60'/0'/0/0");
});

test("rejects wrong version, network, and malformed fields by name", () => {
  assert.throws(() => parseMandateFile(GOOD.replace("version: 1", "version: 2")), /"version"/);
  assert.throws(() => parseMandateFile(GOOD.replace("eip155:84532", "eip155:1")), /"network"/);
  assert.throws(() => parseMandateFile(GOOD.replace('"5000000"', '"5.0"')), /"ceilingBaseUnits"/);
  assert.throws(() => parseMandateFile(GOOD.replace("ab".repeat(32), "ab")), /"salt"/);
  assert.throws(() => parseMandateFile(GOOD.replace("0x000000000000000000000000000000000000dEaD", "nope")), /"receiver"/);
  assert.throws(() => parseMandateFile(GOOD.replace("https://sepolia.base.org", "gopher://x")), /"rpcUrl"/);
  assert.throws(() => parseMandateFile("[]"), /mapping/);
  assert.throws(() => parseMandateFile(":\n: bad"), /invalid YAML/);
});
