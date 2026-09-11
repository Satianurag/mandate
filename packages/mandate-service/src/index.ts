import { completeMerchantLifecycle } from "../../gateway/src/merchant-lifecycle.ts";
import { ESCROW_READ_ABI } from "../../gateway/src/reconciliation.ts";
import { BATCH_SETTLEMENT_ADDRESS } from "@x402/evm";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
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
import { join } from "node:path";
import { Journal } from "../../gateway/src/journal.ts";
import { handlePaidRequest } from "../../gateway/src/paid-handler.ts";
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
  autoSettlement?: boolean;
  controlToken?: string;
  claimIntervalSecs?: number;
  settleIntervalSecs?: number;
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
  const facilitator = new HTTPFacilitatorClient({ url: full.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitator);
  const batchScheme = new BatchSettlementEvmScheme(full.receiver, {
    storage: new FileChannelStorage({ directory: full.storageDir }),
  });
  resourceServer.register(network, batchScheme);
  resourceServer.register(network, new UptoEvmScheme());
  const routes: RoutesConfig = {
    "GET /analytics": {
      accepts: {
        scheme: "batch-settlement",
        network,
        payTo: full.receiver,
        price: { asset: full.asset, amount: full.priceBaseUnits },
        extra,
        maxTimeoutSeconds: 900,
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
      description: "Fixed-price Agent0 query with a capped authorization — authorize up to $0.05, settle actual",
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

  const journal = new Journal(join(full.storageDir, "merchant.sqlite"));
  const channelManager = batchScheme.createChannelManager(facilitator, network, full.asset);
  const releaseMerchant = journal.own("merchant-service");
  let lifecycleBusy = false;
  const server = createServer((req, res) => {
    if (["/admin/claim-settle","/admin/refund-receipts"].includes((req.url ?? "").split("?")[0] ?? "")) {
      void (async () => {
        if (req.method !== "POST" || req.headers.origin || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")) throw new Error("Local merchant administration only");
        const offered = req.headers.authorization ?? "";
        const wanted = `Bearer ${cfg.controlToken ?? ""}`;
        if (!cfg.controlToken || !timingSafeEqual(createHash("sha256").update(offered).digest(), createHash("sha256").update(wanted).digest())) {
          res.writeHead(401, {"content-type":"application/json"}).end('{"error":"Merchant admin authentication required"}'); return;
        }
        if (lifecycleBusy) { res.writeHead(409).end('{"error":"Settlement already in progress"}'); return; }
        let text = "";
        for await (const b of req) { text += String(b); if (text.length > 2048) throw new Error("Admin request too large"); }
        const body = JSON.parse(text);
        if (typeof body.channelId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.channelId)) throw new Error("A specific channel ID is required");
        if ((req.url ?? "").split("?")[0] === "/admin/refund-receipts") {
          const candidates:unknown[]=[];
          for (const row of journal.db.prepare("SELECT response FROM outcomes WHERE response IS NOT NULL").all()) {
            try {
              const response=JSON.parse(String(row.response));
              const encoded=response.headers?.["PAYMENT-RESPONSE"] ?? response.headers?.["payment-response"];
              if (!encoded) continue;
              const receipt=JSON.parse(Buffer.from(encoded,"base64").toString("utf8"));
              const state=receipt.extra?.channelState;
              if(receipt.success && receipt.network===network && state?.channelId?.toLowerCase()===body.channelId.toLowerCase() && BigInt(state.refundNonce??0)>0n && /^0x[0-9a-fA-F]{64}$/.test(receipt.transaction??""))candidates.push(receipt);
            }catch{continue;}
          }
          res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"}).end(JSON.stringify({network,candidates}));return;
        }
        lifecycleBusy = true;
        try {
          journal.event("merchant", null, "merchant.claim_requested", {channelId:body.channelId});
          const result = await completeMerchantLifecycle({
            claim: () => channelManager.claim({selectClaimChannels: channels => channels.filter(c => c.channelId.toLowerCase() === body.channelId.toLowerCase())}),
            settle: () => channelManager.settle(),
            receiverState: async () => {
              const [claimed,settled] = await rpcClient(full.rpcUrl).readContract({address:BATCH_SETTLEMENT_ADDRESS,abi:ESCROW_READ_ABI,functionName:"receivers",args:[full.receiver,full.asset]});
              return {claimed,settled};
            },
            record: (kind,data) => {journal.event("merchant",null,kind,data);},
          });
          res.writeHead(200, {"content-type":"application/json","cache-control":"no-store"}).end(JSON.stringify({network, ...result}));
        } finally { lifecycleBusy = false; }
      })().catch(e => {
        journal.event("merchant", null, "merchant.lifecycle_failed", {message:e instanceof Error ? e.message : String(e)});
        if (!res.headersSent) res.writeHead(400, {"content-type":"application/json"});
        res.end(JSON.stringify({error:e instanceof Error ? e.message : String(e)}));
      });
      return;
    }
    void handlePaidRequest({ req, res, httpServer, journal,
      prepare: query => liveAnalyticsBody(query, {}, { fetchRows: cfg.fetchRows }),
      actualAmount: path => path === "/usage" ? full.priceBaseUnits : undefined,
    }).catch(e => {
      console.error("Merchant handler failed:", e instanceof Error ? e.message : String(e));
      if (!res.headersSent) res.writeHead(503, { "content-type": "application/json" });
      res.end('{"error":"Merchant could not persist the request outcome"}');
    });
  });
  server.once("listening", () => {
    if (cfg.autoSettlement === false) return;
    channelManager.start({
      claimIntervalSecs: cfg.claimIntervalSecs ?? 60, settleIntervalSecs: cfg.settleIntervalSecs ?? 300, refundIntervalSecs: 3600,
      maxClaimsPerBatch: 100,
      selectClaimChannels: channels => {
        if (channels.length) journal.event("merchant", null, "merchant.claim_requested", { count: channels.length });
        return channels;
      },
      onClaim: result => { journal.event("merchant", null, "merchant.claim_confirmed", result); },
      onSettle: result => { journal.event("merchant", null, "merchant.revenue_settled", result); },
      onRefund: result => { journal.event("merchant", null, "merchant.refund_confirmed", result); },
      onError: error => { journal.event("merchant", null, "merchant.lifecycle_failed", { message: error instanceof Error ? error.message : String(error) }); },
    });
  });
  server.once("close", () => { void channelManager.stop().finally(() => { releaseMerchant(); journal.close(); }); });
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
      autoSettlement: process.env.MANDATE_AUTO_SETTLEMENT !== "0",
      controlToken: process.env.MANDATE_MERCHANT_ADMIN_TOKEN_FILE ? (await readFile(process.env.MANDATE_MERCHANT_ADMIN_TOKEN_FILE, "utf8")).trim() : undefined,
      priceBaseUnits: process.env.MANDATE_PRICE_BASE_UNITS ?? PRICE_BASE_UNITS,
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
