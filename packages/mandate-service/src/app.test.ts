import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertUsdcDeployment,
  buildService,
  resolveEip712Domain,
  resolveReceiverAuthorizer,
  USDC_BASE_SEPOLIA,
} from "./index.ts";

// Hermetic by construction: a stub facilitator (advertisement only — the 402
// path never calls verify/settle) and a stub JSON-RPC endpoint (canned
// chainId/symbol/decimals). Proves the 402 offer shape, the boot gates, and
// the no-payment-header → 402 mapping with zero chain access.

const RECEIVER = "0x000000000000000000000000000000000000dEaD";
const AUTHORIZER = "0x0000000000000000000000000000000000000002";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function stubFacilitator(t: { after: (fn: () => void) => void }, kinds: unknown[]): Promise<string> {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/supported") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ kinds, extensions: [], signers: {} }));
      return;
    }
    res.writeHead(500).end(JSON.stringify({ error: "stub facilitator: must not be called" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      t.after(() => server.close());
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    });
  });
}

/** Minimal eth_chainId + eth_call JSON-RPC stub. */
function abiString(value: string): string {
  const hex = Buffer.from(value, "utf8").toString("hex");
  const len = value.length.toString(16).padStart(64, "0");
  return `0x${"0".repeat(62)}20${len}${hex.padEnd(64, "0")}`;
}

function stubRpc(
  t: { after: (fn: () => void) => void },
  opts: {
    chainId: number;
    symbol: string;
    decimals: number;
    name?: string;
    tokenVersion?: string;
  }
): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body) as {
        id: number;
        method: string;
        params: { data?: string }[];
      };
      let result: string;
      if (method === "eth_chainId") {
        result = `0x${opts.chainId.toString(16)}`;
      } else if (method === "eth_call") {
        const data = params[0]?.data ?? "";
        if (data.startsWith("0x95d89b41")) {
          result = abiString(opts.symbol);
        } else if (data.startsWith("0x313ce567")) {
          result = `0x${opts.decimals.toString(16).padStart(64, "0")}`;
        } else if (data.startsWith("0x06fdde03")) {
          result = abiString(opts.name ?? "USDC");
        } else if (data.startsWith("0x54fd4d50")) {
          result = abiString(opts.tokenVersion ?? "2");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "nope" } }));
          return;
        }
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "nope" } }));
        return;
      }
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

const KINDS = [
  {
    x402Version: 2,
    scheme: "batch-settlement",
    network: "eip155:84532",
    extra: { receiverAuthorizer: AUTHORIZER },
  },
  {
    x402Version: 2,
    scheme: "upto",
    network: "eip155:84532",
    extra: { facilitatorAddress: AUTHORIZER },
  },
];

test("boot resolves the receiverAuthorizer live, refuses without it", async (t) => {
  const url = await stubFacilitator(t, KINDS);
  assert.equal(await resolveReceiverAuthorizer(url), AUTHORIZER);
  const bare = await stubFacilitator(t, []);
  await assert.rejects(() => resolveReceiverAuthorizer(bare), /does not advertise/);
});

test("boot reads the live EIP-712 domain from the token", async (t) => {
  const rpc = await stubRpc(t, {
    chainId: 84532,
    symbol: "USDC",
    decimals: 6,
    name: "USDC",
    tokenVersion: "2",
  });
  assert.deepEqual(await resolveEip712Domain(rpc, USDC_BASE_SEPOLIA as `0x${string}`), {
    name: "USDC",
    version: "2",
  });
});

test("boot proves the priced asset is USDC on Base Sepolia", async (t) => {
  const good = await stubRpc(t, { chainId: 84532, symbol: "USDC", decimals: 6 });
  await assertUsdcDeployment(good, USDC_BASE_SEPOLIA as `0x${string}`);
  const wrongChain = await stubRpc(t, { chainId: 1, symbol: "USDC", decimals: 6 });
  await assert.rejects(
    () => assertUsdcDeployment(wrongChain, USDC_BASE_SEPOLIA as `0x${string}`),
    /not Base Sepolia/
  );
  const wrongToken = await stubRpc(t, { chainId: 84532, symbol: "FAKE", decimals: 6 });
  await assert.rejects(
    () => assertUsdcDeployment(wrongToken, USDC_BASE_SEPOLIA as `0x${string}`),
    /want USDC\/6/
  );
});

test("GET /analytics without payment returns the batch-settlement 402 offer", async (t) => {
  const facilitatorUrl = await stubFacilitator(t, KINDS);
  const rpcUrl = await stubRpc(t, { chainId: 84532, symbol: "USDC", decimals: 6, name: "USDC", tokenVersion: "2" });
  const dir = await mkdtemp(join(tmpdir(), "mandate-svc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { server } = await buildService({
    facilitatorUrl,
    rpcUrl,
    storageDir: dir,
    receiver: RECEIVER as `0x${string}`,
    asset: ASSET as `0x${string}`,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const res = await fetch(`${base}/analytics?q=${encodeURIComponent("{ a { id } }")}`);
  assert.equal(res.status, 402);
  // v2 rides the offer in the PAYMENT-REQUIRED header (base64 JSON), not the
  // body. Decode with x402's own decoder — the client does the same.
  const header = res.headers.get("payment-required");
  assert.ok(header, "402 must carry PAYMENT-REQUIRED");
  const { decodePaymentRequiredHeader } = await import("@x402/core/http");
  const body = decodePaymentRequiredHeader(header);
  assert.equal(body.accepts.length, 1);
  const offer = body.accepts[0]!;
  const extra = offer.extra as { receiverAuthorizer: string; name: string; version: string };
  assert.equal(offer.scheme, "batch-settlement");
  assert.equal(offer.network, "eip155:84532");
  assert.equal(offer.asset.toLowerCase(), ASSET.toLowerCase());
  assert.equal(offer.amount, "10000");
  assert.equal(offer.payTo.toLowerCase(), RECEIVER.toLowerCase());
  assert.equal(extra.receiverAuthorizer, AUTHORIZER);
  assert.equal(extra.name, "USDC");
  assert.equal(extra.version, "2");

  const elsewhere = await fetch(`${base}/nope`);
  assert.equal(elsewhere.status, 404);

  const usage = await fetch(`${base}/usage`);
  assert.equal(usage.status, 402);
  const usageHeader = usage.headers.get("payment-required");
  assert.ok(usageHeader, "upto 402 must carry PAYMENT-REQUIRED");
  const usageBody = decodePaymentRequiredHeader(usageHeader);
  assert.equal(usageBody.accepts[0]!.scheme, "upto");
  assert.equal(usageBody.accepts[0]!.network, "eip155:84532");
  assert.equal(usageBody.accepts[0]!.amount, "50000");
  assert.ok(
    usageBody.extensions && "eip2612GasSponsoring" in usageBody.extensions,
    "upto 402 must advertise eip2612GasSponsoring so Permit2 allowance can be gas-sponsored"
  );
});
