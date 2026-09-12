import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FACILITATOR_URL } from "./facilitators.ts";
import { DEFAULT_SETUP, LOCAL_TOOL_IDS, resolveFacilitatorUrl } from "./workspace-setup.ts";

test("resolveFacilitatorUrl defaults to the loopback self-hosted facilitator", () => {
  assert.equal(resolveFacilitatorUrl({ ...DEFAULT_SETUP, facilitatorUrl: "" }), DEFAULT_FACILITATOR_URL);
  assert.equal(resolveFacilitatorUrl({ ...DEFAULT_SETUP, facilitatorUrl: "https://facilitator.example" }), "https://facilitator.example");
});

test("LOCAL_TOOL_IDS includes Graph tools and local Coinbase spot prices", () => {
  assert.ok(LOCAL_TOOL_IDS.has("graph-agent0"));
  assert.ok(LOCAL_TOOL_IDS.has("crypto-prices"));
  assert.equal(LOCAL_TOOL_IDS.has("web-search"), false);
});
