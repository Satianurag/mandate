/**
 * The EVM paid counterpart — subgraph analytics gated by batch-settlement.
 *
 * One tap on the Ledger opens a mandate; afterwards every call to
 * GET /analytics rides a voucher inside the mandate's ceiling. The x402
 * resource-server harness owns the 402/verify/settle flow
 * (`x402HTTPResourceServer`); this file is the node:http skin, the route
 * price, and the boot checks. `chainId` 296 serves the same stock scheme
 * with Permit2 when the token has no EIP-3009.
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
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { createPublicClient, http } from "viem";
import { BASE_SEPOLIA } from "../../gateway/src/facilitators.ts";
import { caip2ForChainId } from "../../gateway/src/chains.ts";
import { nodeAdapter } from "../../gateway/src/http-adapter.ts";
import { liveAnalyticsBody, type Agent0Row } from "../../gateway/src/analytics.ts";
import { assertFacilitatorKinds } from "../../gateway/src/discovery.ts";

/** Default envelope network. Hedera EVM `eip155:296` is opt-in via chainId. */
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
  /** Live `eth_chainId` must match. Default Base Sepolia. */
  chainId?: number;
  fetchRows?: (query: string) => Promise<Agent0Row[]>;
}

export type AssetTransferMethod = "eip3009" | "permit2";

export interface UsdcAssetInfo {
  chainId: number;
  symbol: string;
  decimals: number;
  name: string;
  version: string | null;
  transferMethod: AssetTransferMethod;
  eip2612: boolean;
}

/**
 * Resolve the receiverAuthorizer from the facilitator's live /supported.
 * Refuses to serve when the advertisement is missing — a rotated or
 * withdrawn authorizer must fail here with its name, not per-request.
 */
export async function resolveReceiverAuthorizer(
  facilitatorUrl: string,
  network: string = SERVICE_NETWORK
): Promise<`0x${string}`> {
  const client = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const supported = await client.getSupported();
  const kind = supported.kinds.find(
    (k) => k.scheme === "batch-settlement" && k.network === network
  );
  const authorizer = (kind?.extra as { receiverAuthorizer?: unknown } | undefined)
    ?.receiverAuthorizer;
  if (typeof authorizer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(authorizer)) {
    throw new Error(
      `Facilitator ${facilitatorUrl} does not advertise batch-settlement@${network} with a receiverAuthorizer.`
    );
  }
  return authorizer as `0x${string}`;
}

function rpcClient(rpcUrl: string) {
  return createPublicClient({ transport: http(rpcUrl) });
}

/**
 * Live token facts. Circle FiatToken answers `version()` (EIP-3009 / 2612).
 * Hedera HTS USDC's ERC-20 facade does not — stock x402 then requires
 * `extra.assetTransferMethod: "permit2"` (not a custom scheme).
 */
export async function probeUsdcAsset(
  rpcUrl: string,
  asset: `0x${string}`
): Promise<UsdcAssetInfo> {
  const client = rpcClient(rpcUrl);
  const chainId = await client.getChainId();
  caip2ForChainId(chainId);
  const [symbol, decimals, name] = await Promise.all([
    client.readContract({ address: asset, abi: ERC20_MIN_ABI, functionName: "symbol" }),
    client.readContract({ address: asset, abi: ERC20_MIN_ABI, functionName: "decimals" }),
    client.readContract({ address: asset, abi: ERC20_MIN_ABI, functionName: "name" }),
  ]);
  if (symbol !== "USDC" || decimals !== 6) {
    throw new Error(
      `Asset ${asset} answers symbol()=${JSON.stringify(symbol)} decimals()=${decimals}, want USDC/6.`
    );
  }
  let version: string | null = null;
  try {
    const v = await client.readContract({
      address: asset,
      abi: ERC20_MIN_ABI,
      functionName: "version",
    });
    if (v) version = v;
  } catch {
    version = null;
  }
  const eip2612 = Boolean(version);
  return {
    chainId,
    symbol,
    decimals,
    name,
    version,
    transferMethod: eip2612 ? "eip3009" : "permit2",
    eip2612,
  };
}

/**
 * Prove the priced asset is USDC on the requested mandate testnet. Throws otherwise.
 */
export async function assertUsdcDeployment(
  rpcUrl: string,
  asset: `0x${string}`,
  expectedChainId: number = SERVICE_CHAIN_ID
): Promise<UsdcAssetInfo> {
  const chainId = await rpcClient(rpcUrl).getChainId();
  if (chainId !== expectedChainId) {
    throw new Error(
      `RPC chain ${chainId} is not the priced network (${expectedChainId}).`
    );
  }
  return probeUsdcAsset(rpcUrl, asset);
}

/**
 * EIP-712 domain for EIP-3009 deposits. Circle FiatToken uses name() and
 * version() as the typed-data domain — hardcoding "USD Coin" signed the
 * wrong digest on Base Sepolia, where name() is "USDC". Read live at boot.
 * Returns null when the token has no `version()` (HTS ERC-20 facade).
 */
export async function resolveEip712Domain(
  rpcUrl: string,
  asset: `0x${string}`
): Promise<{ name: string; version: string } | null> {
  const info = await probeUsdcAsset(rpcUrl, asset);
  if (!info.version) return null;
  if (!info.name) {
    throw new Error(`Asset ${asset} returned empty EIP-712 name.`);
  }
  return { name: info.name, version: info.version };
}

export interface BuiltService {
  server: Server;
  receiverAuthorizer: `0x${string}`;
}

export async function buildService(cfg: ServiceConfig): Promise<BuiltService> {
  const chainId = cfg.chainId ?? SERVICE_CHAIN_ID;
  const network = caip2ForChainId(chainId);
  const full = {
    asset: (cfg.asset ?? USDC_BASE_SEPOLIA) as `0x${string}`,
    priceBaseUnits: cfg.priceBaseUnits ?? PRICE_BASE_UNITS,
    ...cfg,
  };
  const info = await assertUsdcDeployment(full.rpcUrl, full.asset, chainId);
  const receiverAuthorizer = await resolveReceiverAuthorizer(full.facilitatorUrl, network);
  await assertFacilitatorKinds(full.facilitatorUrl, [
    `batch-settlement@${network}`,
    `upto@${network}`,
  ]);
  const extra: Record<string, unknown> = { receiverAuthorizer };
  if (info.version) {
    extra.name = info.name;
    extra.version = info.version;
  }
  if (info.transferMethod === "permit2") extra.assetTransferMethod = "permit2";
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: full.facilitatorUrl }));
  resourceServer.register(
    network,
    new BatchSettlementEvmScheme(full.receiver, {
      storage: new FileChannelStorage({ directory: full.storageDir }),
    })
  );
  resourceServer.register(network, new UptoEvmScheme());
  const routes: RoutesConfig = {
    "GET /analytics": {
      accepts: {
        scheme: "batch-settlement",
        network,
        payTo: full.receiver,
        price: { asset: full.asset, amount: full.priceBaseUnits },
        extra,
      },
      description: "Subgraph analytics — $0.01 per call inside your mandate",
    },
    "GET /usage": {
      accepts: {
        scheme: "upto",
        network,
        payTo: full.receiver,
        price: { asset: full.asset, amount: "50000" },
        extra: info.version
          ? { name: info.name, version: info.version }
          : { assetTransferMethod: "permit2" },
      },
      description: "Usage-priced Agent0 sample — authorize up to $0.05, settle actual",
      extensions: info.eip2612
        ? { eip2612GasSponsoring: {} }
        : { erc20ApprovalGasSponsoring: {} },
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
      const actual =
        path === "/usage" ? { amount: full.priceBaseUnits } : undefined;
      const settled = await httpServer.processSettlement(
        out.paymentPayload,
        out.paymentRequirements,
        out.declaredExtensions,
        { request: { adapter, path, method: req.method ?? "GET" } },
        actual
      );
      if (!settled.success) {
        console.error("mandate settle failed:", JSON.stringify(settled));
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: settled.errorReason ?? settled }));
        return;
      }
      try {
        const body = await liveAnalyticsBody(
          query,
          {
            amount: actual?.amount ?? full.priceBaseUnits,
            asset: full.asset,
            txHash: settled.transaction,
            scheme: path === "/usage" ? "upto" : "batch-settlement",
          },
          { fetchRows: cfg.fetchRows }
        );
        res.writeHead(200, { "content-type": "application/json", ...settled.headers });
        res.end(JSON.stringify(body));
      } catch (e) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
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
    const chainId = Number(flag("--chain-id") ?? process.env.MANDATE_SERVICE_CHAIN_ID ?? SERVICE_CHAIN_ID);
    const rpcUrl =
      process.env.MANDATE_SERVICE_RPC_URL ??
      (chainId === SERVICE_CHAIN_ID
        ? need("MANDATE_EVM_RPC_URL")
        : (process.env.MANDATE_HEDERA_EVM_RPC_URL ?? "https://testnet.hashio.io/api"));
    const asset = (flag("--asset") ?? process.env.MANDATE_SERVICE_ASSET ?? USDC_BASE_SEPOLIA) as `0x${string}`;
    if (chainId === 296 && asset.toLowerCase() === USDC_BASE_SEPOLIA.toLowerCase()) {
      throw new Error(
        "eip155:296 cannot price Base Sepolia USDC; set MANDATE_SERVICE_ASSET to Circle HTS USDC (0.0.429274 EVM alias)."
      );
    }
    const receiver = flag("--receiver") ?? need("MANDATE_SERVICE_RECEIVER");
    if (!/^0x[0-9a-fA-F]{40}$/.test(receiver)) throw new Error(`Not an address: ${receiver}.`);
    const { server } = await buildService({
      facilitatorUrl: process.env.MANDATE_FACILITATOR_URL ?? "http://127.0.0.1:8406",
      rpcUrl,
      storageDir: process.env.MANDATE_SERVICE_STATE ?? "./state/mandate-service",
      receiver: receiver as `0x${string}`,
      asset,
      chainId,
    });
    const port = Number(process.env.MANDATE_SERVICE_PORT ?? 8405);
    const host = process.env.MANDATE_SERVICE_HOST ?? "127.0.0.1";
    server.listen(port, host, () =>
      console.log(
        `mandate service on ${host}:${port} (batch-settlement@eip155:${chainId} USDC ${PRICE_BASE_UNITS} base units)`
      )
    );
  } catch (e) {
    console.error(`Cannot start mandate service: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
