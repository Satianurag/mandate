/**
 * The EVM paid counterpart — subgraph analytics gated by batch-settlement.
 *
 * One tap on the Ledger opens a mandate; afterwards every call to
 * GET /analytics rides a voucher inside the mandate's ceiling. The x402
 * resource-server harness owns the 402/verify/settle flow
 * (`x402HTTPResourceServer`); this file is the node:http skin, the route
 * price, and the boot checks.
 *
 * Boot refuses to serve unless:
 * - the facilitator advertises batch-settlement on eip155:84532 with a
 *   receiverAuthorizer (invariant 3: never hardcoded, never missing), and
 * - the priced asset answers symbol()=="USDC" && decimals()==6 on the
 *   mandate chain (never price the wrong token).
 */

import { createServer, type Server } from "node:http";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type RoutesConfig,
} from "@x402/core/server";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import { FileChannelStorage } from "@x402/evm/batch-settlement/server/file-storage";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { BASE_SEPOLIA } from "../../gateway/src/facilitators.ts";
import { nodeAdapter } from "../../gateway/src/http-adapter.ts";

export const SERVICE_NETWORK = "eip155:84532";
export const SERVICE_CHAIN_ID = 84532;
/** Circle USDC on Base Sepolia — verified live at boot (never trusted). */
export const USDC_BASE_SEPOLIA = BASE_SEPOLIA.usdc as `0x${string}`;
/** Flat $0.01 per call, 6 decimals. */
export const PRICE_BASE_UNITS = "10000";

const ERC20_MIN_ABI = [
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    name: "name",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    name: "version",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

export interface ServiceConfig {
  facilitatorUrl: string;
  rpcUrl: string;
  /** Where server channel snapshots persist ({dir}/server/*.json). */
  storageDir: string;
  receiver: `0x${string}`;
  asset?: `0x${string}`;
  priceBaseUnits?: string;
}

/**
 * Resolve the receiverAuthorizer from the facilitator's live /supported.
 * Refuses to serve when the advertisement is missing — a rotated or
 * withdrawn authorizer must fail here with its name, not per-request.
 */
export async function resolveReceiverAuthorizer(facilitatorUrl: string): Promise<`0x${string}`> {
  const client = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const supported = await client.getSupported();
  const kind = supported.kinds.find(
    (k) => k.scheme === "batch-settlement" && k.network === SERVICE_NETWORK
  );
  const authorizer = (kind?.extra as { receiverAuthorizer?: unknown } | undefined)
    ?.receiverAuthorizer;
  if (typeof authorizer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(authorizer)) {
    throw new Error(
      `Facilitator ${facilitatorUrl} does not advertise batch-settlement@${SERVICE_NETWORK} with a receiverAuthorizer.`
    );
  }
  return authorizer as `0x${string}`;
}

/**
 * Prove the priced asset is USDC on the mandate chain. Throws otherwise.
 * Exported so the hermetic suite can run it against a stub RPC endpoint.
 */
export async function assertUsdcDeployment(rpcUrl: string, asset: `0x${string}`): Promise<void> {
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  if (chainId !== SERVICE_CHAIN_ID) {
    throw new Error(`RPC chain ${chainId} is not Base Sepolia (${SERVICE_CHAIN_ID}).`);
  }
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: asset, abi: ERC20_MIN_ABI, functionName: "symbol" }),
    client.readContract({ address: asset, abi: ERC20_MIN_ABI, functionName: "decimals" }),
  ]);
  if (symbol !== "USDC" || decimals !== 6) {
    throw new Error(
      `Asset ${asset} answers symbol()=${JSON.stringify(symbol)} decimals()=${decimals}, want USDC/6.`
    );
  }
}

/**
 * EIP-712 domain for EIP-3009 deposits. Circle FiatToken uses name() and
 * version() as the typed-data domain — hardcoding "USD Coin" signed the
 * wrong digest on Base Sepolia, where name() is "USDC". Read live at boot.
 */
export async function resolveEip712Domain(
  rpcUrl: string,
  asset: `0x${string}`
): Promise<{ name: string; version: string }> {
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const [name, version] = await Promise.all([
    client.readContract({ address: asset, abi: ERC20_MIN_ABI, functionName: "name" }),
    client.readContract({ address: asset, abi: ERC20_MIN_ABI, functionName: "version" }),
  ]);
  if (!name || !version) {
    throw new Error(`Asset ${asset} returned empty EIP-712 name/version.`);
  }
  return { name, version };
}

export interface BuiltService {
  server: Server;
  receiverAuthorizer: `0x${string}`;
}

export async function buildService(cfg: ServiceConfig): Promise<BuiltService> {
  const full = {
    asset: (cfg.asset ?? USDC_BASE_SEPOLIA) as `0x${string}`,
    priceBaseUnits: cfg.priceBaseUnits ?? PRICE_BASE_UNITS,
    ...cfg,
  };
  const receiverAuthorizer = await resolveReceiverAuthorizer(full.facilitatorUrl);
  const eip712 = await resolveEip712Domain(full.rpcUrl, full.asset);
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: full.facilitatorUrl }));
  resourceServer.register(
    SERVICE_NETWORK,
    new BatchSettlementEvmScheme(full.receiver, {
      storage: new FileChannelStorage({ directory: full.storageDir }),
    })
  );
  const routes: RoutesConfig = {
    "GET /analytics": {
      accepts: {
        scheme: "batch-settlement",
        network: SERVICE_NETWORK,
        payTo: full.receiver,
        price: { asset: full.asset, amount: full.priceBaseUnits },
        extra: {
          receiverAuthorizer,
          // Live token EIP-712 domain (Base Sepolia USDC is name "USDC", not "USD Coin").
          name: eip712.name,
          version: eip712.version,
        },
      },
      description: "Subgraph analytics — $0.01 per call inside your mandate",
    },
  };
  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  // Fetches facilitator /supported and validates every route has scheme +
  // facilitator backing. Without this, requests fail with "make sure to
  // call initialize()" — boot must not serve a half-wired server.
  await httpServer.initialize();

  const server = createServer(async (req, res) => {
    try {
      const base = `http://${req.headers.host ?? "localhost"}`;
      const adapter = nodeAdapter(req, base);
      const path = new URL(req.url ?? "/", base).pathname;
      const out = await httpServer.processHTTPRequest({
        adapter,
        path,
        method: req.method ?? "GET",
      });
      if (out.type === "no-payment-required") {
        res.writeHead(404).end();
        return;
      }
      if (out.type === "payment-error") {
        res.writeHead(out.response.status, out.response.headers);
        res.end(JSON.stringify(out.response.body));
        return;
      }
      // Verified: run the handler, then settle. The PAYMENT-RESPONSE headers
      // from processSettlement are what advance the client's vouchers —
      // dropping them would fork the channel state from the chain.
      const query = new URL(req.url ?? "/", base).searchParams.get("q") ?? "{ agents { id } }";
      const settled = await httpServer.processSettlement(
        out.paymentPayload,
        out.paymentRequirements,
        out.declaredExtensions,
        { request: { adapter, path, method: req.method ?? "GET" } }
      );
      if (!settled.success) {
        console.error("mandate settle failed:", JSON.stringify(settled));
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: settled.errorReason ?? settled }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", ...settled.headers });
      res.end(
        JSON.stringify({
          ok: true,
          query,
          paid: { amount: full.priceBaseUnits, asset: full.asset, txHash: settled.transaction },
          rows: [{ id: "agent-demo-1", feedbackCount: 42 }],
        })
      );
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });
  return { server, receiverAuthorizer };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const need = (name: string): string => {
    const v = process.env[name];
    if (!v) {
      console.error(`Missing ${name}`);
      process.exit(1);
    }
    return v;
  };
  const flag = (name: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const rpcUrl = need("MANDATE_EVM_RPC_URL");
    const asset = (flag("--asset") ?? USDC_BASE_SEPOLIA) as `0x${string}`;
    await assertUsdcDeployment(rpcUrl, asset);
    const receiver = flag("--receiver") ?? need("MANDATE_SERVICE_RECEIVER");
    if (!/^0x[0-9a-fA-F]{40}$/.test(receiver)) throw new Error(`Not an address: ${receiver}.`);
    const { server } = await buildService({
      facilitatorUrl: process.env.MANDATE_FACILITATOR_URL ?? "http://127.0.0.1:8406",
      rpcUrl,
      storageDir: process.env.MANDATE_SERVICE_STATE ?? "./state/mandate-service",
      receiver: receiver as `0x${string}`,
      asset,
    });
    const port = Number(process.env.MANDATE_SERVICE_PORT ?? 8405);
    const host = process.env.MANDATE_SERVICE_HOST ?? "127.0.0.1";
    server.listen(port, host, () =>
      console.log(`mandate service on ${host}:${port} (batch-settlement USDC $${PRICE_BASE_UNITS} base units)`)
    );
  } catch (e) {
    console.error(`Cannot start mandate service: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
