/**
 * HCS-14 conformance, hermetic: the SDK generates offline and
 * deterministically, so every claim here runs with zero network.
 *
 * The pinned vector is doubly-derived: the spec's canonical JSON for
 * Test Vector 1, hashed once by the SDK and once by an independent
 * from-scratch SHA-384+Base58 implementation — byte-identical (F25).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createUaid } from "@hashgraphonline/standards-sdk";
import {
  MANDATE_AGENT_VERSION,
  MANDATE_REGISTRY,
  MANDATE_SKILLS,
  operatorAgentData,
  assertValidSkills,
  deriveOperatorUaid,
  parseUaid,
  buildOperatorProfile,
} from "./uaid.ts";

const VECTOR1_INPUT = {
  registry: "hol",
  name: "Support Agent",
  version: "1.0.0",
  protocol: "hcs-10",
  nativeId: "hedera:testnet:0.0.123456",
  skills: [17, 0],
};

const VECTOR1_UAID =
  "uaid:aid:791vW8NebBtqg1oSUJz8MstX8i7guBrMAu4DTFyTwFY21MMHXbUU9YxqQbXgbEbrPj" +
  ";uid=0;registry=hol;nativeId=hedera:testnet:0.0.123456";

test("spec Test Vector 1 pins the exact UAID (unsorted skills in, sorted hash out)", async () => {
  const uaid = await createUaid(VECTOR1_INPUT, { uid: "0" });
  assert.equal(uaid, VECTOR1_UAID);
});

test("normalization: case + whitespace + skill order do not move the UAID", async () => {
  const uaid = await createUaid(
    {
      ...VECTOR1_INPUT,
      registry: " HOL ",
      protocol: "HCS-10",
      name: "  Support Agent ",
      skills: [0, 17],
    },
    { uid: "0" }
  );
  assert.equal(uaid, VECTOR1_UAID);
});

test("derivation is deterministic", async () => {
  const [a, b] = await Promise.all([
    createUaid(VECTOR1_INPUT, { uid: "0" }),
    createUaid(VECTOR1_INPUT, { uid: "0" }),
  ]);
  assert.equal(a, b);
});

test("reserved skills 40-99 are rejected (spec #6, enforced by the wrapper)", () => {
  assert.throws(() => assertValidSkills([50]), /reserved/);
  assert.throws(() => assertValidSkills([0, 99]), /reserved/);
  assert.throws(() => assertValidSkills([-1]), /invalid HCS-14 skill/);
  assert.throws(() => assertValidSkills([1.5]), /invalid HCS-14 skill/);
});

test("empty skills and OASF skills are accepted (spec permits both)", () => {
  assertValidSkills([]);
  assertValidSkills([0, 10102]);
  assertValidSkills(MANDATE_SKILLS);
});

test("parse round-trips the vector", () => {
  const parsed = parseUaid(VECTOR1_UAID);
  assert.equal(parsed.method, "aid");
  assert.equal(parsed.id, "791vW8NebBtqg1oSUJz8MstX8i7guBrMAu4DTFyTwFY21MMHXbUU9YxqQbXgbEbrPj");
  assert.equal(parsed.params.uid, "0");
  assert.equal(parsed.params.registry, "hol");
});

test("operator mapping anchors the payer account as CAIP-10", () => {
  const data = operatorAgentData("0.0.54321", "hedera:testnet");
  assert.equal(data.registry, MANDATE_REGISTRY);
  assert.equal(data.version, MANDATE_AGENT_VERSION);
  assert.equal(data.nativeId, "hedera:testnet:0.0.54321");
  assert.deepEqual(data.skills, MANDATE_SKILLS);
  assert.throws(
    () => operatorAgentData("0.0.54321", "eip155:84532"),
    /unknown Hedera network/
  );
});

test("operator UAID is deterministic and carries the account uid", async () => {
  const a = await deriveOperatorUaid("0.0.54321", "hedera:testnet");
  const b = await deriveOperatorUaid("0.0.54321", "hedera:testnet");
  assert.equal(a, b);
  assert.ok(a.startsWith("uaid:aid:"));
  assert.ok(a.includes("uid=0.0.54321"));
  assert.ok(a.includes("nativeId=hedera:testnet:0.0.54321"));
  const mainnet = await deriveOperatorUaid("0.0.54321", "hedera:mainnet");
  assert.notEqual(mainnet, a, "network is part of the identity");
});

test("operator profile is SDK-schema-valid with the UAID embedded", async () => {
  const uaid = await deriveOperatorUaid("0.0.54321", "hedera:testnet");
  const profile = buildOperatorProfile(uaid, "0.0.54321");
  assert.equal(profile.type, 1, "AI_AGENT");
  assert.equal(profile.uaid, uaid);
  assert.equal(profile.base_account, "0.0.54321");
  assert.equal(profile.aiAgent.model, "mandate-policy-engine/0.1.0");
  assert.ok(profile.aiAgent.capabilities.includes(15), "fraud detection claimed");
});

test("shim drift guard: redeclared SDK values match the real runtime", async () => {
  const sdk = await import("@hashgraphonline/standards-sdk");
  assert.equal(typeof sdk.createUaid, "function");
  assert.equal(typeof sdk.parseHcs14Did, "function");
  assert.equal(typeof sdk.AIAgentProfileSchema?.parse, "function");
  assert.equal(sdk.ProfileType.AI_AGENT, 1);
  assert.equal(sdk.AIAgentType.AUTONOMOUS, 1);
  assert.equal(sdk.AIAgentCapability.KNOWLEDGE_RETRIEVAL, 7);
  assert.equal(sdk.AIAgentCapability.TRANSACTION_ANALYTICS, 10);
  assert.equal(sdk.AIAgentCapability.SECURITY_MONITORING, 13);
  assert.equal(sdk.AIAgentCapability.COMPLIANCE_ANALYSIS, 14);
  assert.equal(sdk.AIAgentCapability.FRAUD_DETECTION, 15);
  assert.equal(sdk.AIAgentCapability.API_INTEGRATION, 17);
});
