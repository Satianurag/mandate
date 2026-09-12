import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { Journal } from "./journal.ts";
import { AgentFundingController, type AgentFundingOptions } from "./agent-funding.ts";
import { EXACT_USDC, type ExactAgentAuthority } from "./agent-exact.ts";

const payer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const spending = privateKeyToAccount(`0x${"22".repeat(32)}`);
const hash = `0x${"ab".repeat(32)}`;

function setup(options: { settlementFails?: boolean; stopDuringSign?: boolean; balance?: bigint } = {}) {
  const journal = new Journal(":memory:");
  const authority: ExactAgentAuthority = {
    id: "test-funding-authority",
    network: "eip155:8453",
    asset: EXACT_USDC["eip155:8453"],
    payerAddress: payer.address,
    spendingAddress: spending.address,
    expiresAt: Date.now() + 3600000,
    ceilingBaseUnits: "250000",
    perCallBaseUnits: "20000",
    windowBaseUnits: "100000",
    windowMs: 3600000,
    tools: [{ id: "graph-protocol", origin: "http://127.0.0.1:8425", pathname: "/tools/graph-protocol", payTo: spending.address }],
  };
  journal.register(authority.id, authority);
  journal.bindIdentity(authority.id, payer.address, spending.address);
  const counts = { sign: 0, settle: 0, verify: 0, lookup: 0 };
  const input: AgentFundingOptions = {
    authority,
    journal,
    rpcUrl: "https://mainnet.base.org",
    facilitatorUrl: "http://127.0.0.1:8426",
    signer: async () => ({
      address: payer.address,
      signTypedData: async params => {
        counts.sign++;
        if (options.stopDuringSign) journal.stop(authority.id);
        return payer.signTypedData(params);
      },
    }),
    chain: {
      chainId: async () => 8453,
      balance: async () => options.balance ?? 1000000n,
      block: async () => 1n,
      findTransaction: async () => { counts.lookup++; return hash; },
    },
    facilitator: {
      getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }),
      verify: async () => ({ isValid: true, payer: payer.address }),
      settle: async () => {
        counts.settle++;
        if (options.settlementFails) throw new Error("Lost settlement response");
        return { success: true, network: "eip155:8453", transaction: hash, payer: payer.address };
      },
    },
    verify: async ({ offer, payer: sender }) => {
      counts.verify++;
      assert.equal(offer.payTo, spending.address);
      assert.ok(["250000", "100000"].includes(offer.amount));
      assert.equal(sender, payer.address);
    },
  };
  return { journal, authority, counts, controller: new AgentFundingController(input) };
}

test("funding startup and wrong review cannot sign or transfer", async () => {
  const t = setup();
  await assert.rejects(t.controller.fund("changed"), /review changed/);
  assert.equal(t.journal.mandate(t.authority.id)?.deposit, "none");
  t.journal.close();
});

test("initial funding uses one verified exact signature", async () => {
  const t = setup();
  const result = await t.controller.fund(t.controller.review().consentHash);
  assert.equal(result.transaction, hash);
  assert.equal(t.journal.mandate(t.authority.id)?.deposit, "funded");
  assert.equal(t.counts.sign, 1);
  assert.equal(t.counts.settle, 1);
  t.journal.close();
});

test("stopping while device review is active prevents submission", async () => {
  const t = setup({ stopDuringSign: true });
  await assert.rejects(t.controller.fund(t.controller.review().consentHash), /active|stopped/i);
  assert.equal(t.counts.sign, 1);
  assert.equal(t.counts.settle, 0);
  assert.equal(t.journal.mandate(t.authority.id)?.state, "stopped");
  t.journal.close();
});
