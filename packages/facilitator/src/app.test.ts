import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { buildCore, createApp, ecdsa32, type FacilitatorCore } from "./index.ts";

const core: FacilitatorCore = {
  verify: async () => ({ isValid: true, payer: "0x0000000000000000000000000000000000000001" }) as never,
  settle: async () => ({ success: true, transaction: "0xabc" }) as never,
  getSupported: () => ({
    kinds: [
      { x402Version: 2, scheme: "exact", network: "eip155:8453" },
      { x402Version: 2, scheme: "batch-settlement", network: "eip155:8453", extra: { receiverAuthorizer: "0x0000000000000000000000000000000000000002" } },
    ],
    extensions: [],
    signers: { "eip155:8453": ["0x0000000000000000000000000000000000000003"] },
  }),
};

async function withApp(t: { after: (fn: () => void) => void }): Promise<string> {
  const server = createApp(core);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  return `http://127.0.0.1:${addr.port}`;
}

test("GET /supported advertises exact@eip155:8453", async t => {
  const base = await withApp(t);
  const res = await fetch(`${base}/supported`);
  assert.equal(res.status, 200);
  const body = await res.json() as { kinds: Array<{ scheme: string; network: string }> };
  assert.ok(body.kinds.some(k => k.scheme === "exact" && k.network === "eip155:8453"));
});

test("buildCore refuses non-Base mainnet RPC", async t => {
  function stubRpc(chainId: number): Promise<string> {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => { body += c; });
      req.on("end", () => {
        const { id, method } = JSON.parse(body) as { id: number; method: string };
        const result = method === "eth_chainId" ? `0x${chainId.toString(16)}` : "0x6001600101";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      });
    });
    return new Promise(resolve => {
      server.listen(0, "127.0.0.1", () => {
        t.after(() => server.close());
        resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
      });
    });
  }
  const keys = () => ({ submitter: randomBytes(32), authorizer: randomBytes(32) });
  const good = await stubRpc(8453);
  const built = await buildCore(good, keys());
  assert.ok(built.getSupported().kinds.some(k => `${k.scheme}@${k.network}` === "exact@eip155:8453"));
  const wrong = await stubRpc(1);
  await assert.rejects(() => buildCore(wrong, keys()), /not Base mainnet/);
});

test("ecdsa32 accepts Key Ring UTF-8 hex and raw 32-byte secrets", () => {
  const raw = randomBytes(32);
  assert.deepEqual(ecdsa32(raw), raw);
  const hex = raw.toString("hex");
  assert.equal(ecdsa32(Buffer.from(`0x${hex}`, "utf8")).toString("hex"), hex);
});
