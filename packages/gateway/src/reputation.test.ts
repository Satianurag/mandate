import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lookupCounterparty,
  resolveHederaEvmAddress,
  AGENT0_SUBGRAPHS,
} from "./reputation.ts";

/** Route stub fetch by URL: mirror node vs Agent0 gateway. */
function stubFetch(routes: {
  mirror?: unknown | Error;
  agents?: Record<string, unknown>;
  gatewayErrors?: string[];
}) {
  const seen: { url: string; wallet?: string }[] = [];
  const fn = (async (url: string, init?: { body?: string }) => {
    if (url.includes("mirrornode.hedera.com")) {
      seen.push({ url });
      if (routes.mirror instanceof Error) throw routes.mirror;
      if (routes.mirror === undefined) return { status: 404, ok: false, json: async () => null };
      return { status: 200, ok: true, json: async () => routes.mirror };
    }
    const id = url.split("/").pop()!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    seen.push({ url, wallet: body.variables?.wallet });
    if (routes.gatewayErrors?.includes(id)) {
      return { status: 200, ok: true, json: async () => ({ errors: [{ message: "bad indexers" }] }) };
    }
    const agent = routes.agents?.[id] ?? null;
    return { status: 200, ok: true, json: async () => ({ data: { agents: agent ? [agent] : [] } }) };
  }) as unknown as typeof fetch;
  return { fn, seen };
}

const agent = (wallet: string, values: number[]) => ({
  id: "agent-1",
  agentId: "1",
  agentWallet: wallet,
  totalFeedback: String(values.length),
  feedback: values.map((v) => ({ value: String(v), isRevoked: false })),
  validations: [{ response: 1, status: "accepted" }],
});

test("Hedera account ID resolves to its EVM alias before reputation lookup", async () => {
  const evm = "0x79dc34e41b2b591078d3de222c43ecaabd52fccb";
  const baseId = AGENT0_SUBGRAPHS["base"]!;
  const { fn, seen } = stubFetch({
    mirror: { account: "0.0.1234", evm_address: evm },
    agents: { [baseId]: agent(evm, [90, 95]) },
  });
  const rep = await lookupCounterparty("0.0.1234", "key", {
    network: "hedera:testnet",
    fetchFn: fn,
    subgraphs: AGENT0_SUBGRAPHS,
  });
  assert.equal(rep.registered, true);
  assert.equal(rep.feedbackCount, 2);
  assert.ok(Math.abs((rep.meanScore ?? 0) - 0.925) < 1e-9);
  // Every subgraph query carried the RESOLVED alias, never "0.0.1234".
  const wallets = seen.filter((s) => s.wallet).map((s) => s.wallet);
  assert.ok(wallets.length > 0);
  assert.ok(wallets.every((w) => w === evm), `queried wallets: ${wallets.join(",")}`);
});

test("Hedera account without an EVM alias is honestly unregistered", async () => {
  const { fn } = stubFetch({ mirror: { account: "0.0.9999", evm_address: null } });
  const rep = await lookupCounterparty("0.0.9999", "key", { fetchFn: fn, subgraphs: AGENT0_SUBGRAPHS });
  assert.equal(rep.registered, false);
  assert.equal(rep.chainsReachable, rep.chainsQueried);
  assert.deepEqual(rep.chainsFailed, []);
});

test("mirror outage is a coverage failure, not a clean unregistered", async () => {
  const { fn } = stubFetch({ mirror: new Error("socket hang up") });
  const rep = await lookupCounterparty("0.0.1234", "key", { fetchFn: fn, subgraphs: AGENT0_SUBGRAPHS });
  assert.equal(rep.registered, false);
  assert.equal(rep.chainsReachable, 0);
  assert.deepEqual(rep.chainsFailed, ["hedera-mirror"]);
});

test("plain EVM payees never touch the mirror", async () => {
  const evm = "0xf9d1d63f362bd9c98d0d9a1a2b3c4d5e6f70819";
  const { fn, seen } = stubFetch({ agents: {} });
  const rep = await lookupCounterparty(evm, "key", { fetchFn: fn, subgraphs: AGENT0_SUBGRAPHS });
  assert.equal(rep.registered, false);
  assert.ok(!seen.some((s) => s.url.includes("mirrornode")), "mirror must not be queried");
});

test("resolveHederaEvmAddress rejects non-EVM and 404s to null", async () => {
  const { fn } = stubFetch({ mirror: undefined });
  assert.equal(await resolveHederaEvmAddress("0.0.1", "https://m", fn), null);
});
