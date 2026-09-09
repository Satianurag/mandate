import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { buildCore, createApp, type FacilitatorCore } from "./index.ts";

// The wire skin over an injected core: proves the facilitator speaks exactly
// the protocol HTTPFacilitatorClient expects (paths, body shape, passthrough
// semantics) with zero chain access. The scheme behind the real core is
// x402's, proven live by `npm run mandate:open`.

const core: FacilitatorCore = {
  verify: async () =>
    ({ isValid: true, payer: "0x0000000000000000000000000000000000000001" }) as never,
  settle: async () => ({ success: true, transaction: "0xabc" }) as never,
  getSupported: () => ({
    kinds: [
      {
        x402Version: 2,
        scheme: "batch-settlement",
        network: "eip155:84532",
        extra: { receiverAuthorizer: "0x0000000000000000000000000000000000000002" },
      },
    ],
    extensions: [],
    signers: { "eip155:84532": ["0x0000000000000000000000000000000000000003"] },
  }),
};

async function withApp(t: { after: (fn: () => void) => void }): Promise<string> {
  const server = createApp(core);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  return `http://127.0.0.1:${addr.port}`;
}

test("GET /supported returns kinds with the receiverAuthorizer", async (t) => {
  const base = await withApp(t);
  const res = await fetch(`${base}/supported`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { kinds: { scheme: string; extra: { receiverAuthorizer: string } }[] };
  assert.equal(body.kinds[0]!.scheme, "batch-settlement");
  assert.equal(body.kinds[0]!.extra.receiverAuthorizer, "0x0000000000000000000000000000000000000002");
});

test("POST /verify and /settle pass payloads through and return the core result", async (t) => {
  const base = await withApp(t);
  const seen: string[] = [];
  const spy: FacilitatorCore = {
    ...core,
    verify: async (p, r) => {
      seen.push(`verify:${(p as { x402Version: number }).x402Version}:${(r as { scheme: string }).scheme}`);
      return core.verify(p, r);
    },
    settle: async (p, r) => {
      seen.push(`settle:${(p as { x402Version: number }).x402Version}:${(r as { scheme: string }).scheme}`);
      return core.settle(p, r);
    },
  };
  const server = createApp(spy);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const body = { x402Version: 2, paymentPayload: { x402Version: 2 }, paymentRequirements: { scheme: "batch-settlement" } };
  const v = await fetch(`http://127.0.0.1:${port}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(v.status, 200);
  assert.equal(((await v.json()) as { isValid: boolean }).isValid, true);
  const s = await fetch(`http://127.0.0.1:${port}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(s.status, 200);
  assert.deepEqual(seen, ["verify:2:batch-settlement", "settle:2:batch-settlement"]);
  void base;
});

test("buildCore refuses the wrong chain or missing settlement contracts", async (t) => {
  function stubRpc(opts: { chainId: number; code: string }): Promise<string> {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        const { id, method } = JSON.parse(body) as { id: number; method: string };
        const result =
          method === "eth_chainId" ? `0x${opts.chainId.toString(16)}` : opts.code;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        t.after(() => server.close());
        resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
      });
    });
  }
  const keys = () => ({ submitter: randomBytes(32), authorizer: randomBytes(32) });

  const good = await stubRpc({ chainId: 84532, code: "0x6001600101" });
  const core = await buildCore(good, keys());
  assert.equal(typeof core.verify, "function");
  const kinds = core.getSupported().kinds;
  assert.equal(kinds[0]!.scheme, "batch-settlement");
  assert.ok((kinds[0]!.extra as { receiverAuthorizer: string }).receiverAuthorizer?.startsWith("0x"));

  const wrongChain = await stubRpc({ chainId: 1, code: "0x6001600101" });
  await assert.rejects(() => buildCore(wrongChain, keys()), /not Base Sepolia/);
  const noContract = await stubRpc({ chainId: 84532, code: "0x" });
  await assert.rejects(() => buildCore(noContract, keys()), /No contract at/);
});

test("malformed bodies fail 400, unknown routes 404, core crashes 500", async (t) => {
  const base = await withApp(t);
  const bad = await fetch(`${base}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nope: true }),
  });
  assert.equal(bad.status, 400);
  const missing = await fetch(`${base}/nope`);
  assert.equal(missing.status, 404);

  const boom = createApp({
    ...core,
    verify: async () => {
      throw new Error("chain down");
    },
  });
  await new Promise<void>((r) => boom.listen(0, "127.0.0.1", r));
  t.after(() => boom.close());
  const port = (boom.address() as { port: number }).port;
  const err = await fetch(`http://127.0.0.1:${port}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paymentPayload: {}, paymentRequirements: {} }),
  });
  assert.equal(err.status, 500);
  assert.match(((await err.json()) as { error: string }).error, /chain down/);
});
