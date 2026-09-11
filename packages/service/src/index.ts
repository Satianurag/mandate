/**
 * The paid counterpart.
 *
 * Hedera's track requires a live x402-gated service AND a consuming platform
 * that completes real paid requests end to end. We ship both sides, so the
 * demo does not depend on a third party's endpoint staying up during judging.
 *
 * The x402 resource-server harness owns the 402/verify/settle flow
 * (`x402HTTPResourceServer` + the Hedera `exact` scheme); this file is the
 * node:http skin, the metered price, and the boot checks. The facilitator's
 * feePayer is merged into the 402 by the stock scheme
 * (`enhancePaymentRequirements`, invariant 3) -- never hardcoded, never
 * pinned on the command line.
 */

import { createServer, type Server } from "node:http";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type RoutesConfig,
} from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { HBAR_ASSET_ID } from "@x402/hedera";
import { normaliseAmount } from "../../gateway/src/hedera.ts";
import { nodeAdapter } from "../../gateway/src/http-adapter.ts";
import { BLOCKY402_URL, CIRCLE_HEDERA_TESTNET_USDC_HTS } from "../../gateway/src/facilitators.ts";
import { liveAnalyticsBody, type Agent0Row } from "../../gateway/src/analytics.ts";
import { Journal } from "../../gateway/src/journal.ts";
import { handlePaidRequest } from "../../gateway/src/paid-handler.ts";
import { assertFacilitatorKinds } from "../../gateway/src/discovery.ts";

export const SERVICE_NETWORK = "hedera:testnet";

export interface ServiceConfig {
  payTo: string;
  facilitatorUrl: string;
  port: number;
  host: string;
  journalPath?: string;
  fetchRows?: (query: string) => Promise<Agent0Row[]>;
}

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export async function loadConfig(): Promise<ServiceConfig> {
  const payTo =
    flagValue("--pay-to") ??
    process.env.SERVICE_PAY_TO ??
    process.env.MANDATE_HEDERA_ACCOUNT_ID ??
    "";
  if (!payTo || payTo === "0.0.0") {
    throw new Error("Set --pay-to (or SERVICE_PAY_TO) before starting the paid service.");
  }
  return {
    payTo,
    facilitatorUrl: process.env.MANDATE_FACILITATOR_URL ?? BLOCKY402_URL,
    port: Number(process.env.SERVICE_PORT ?? 8403),
    host: process.env.SERVICE_HOST ?? "127.0.0.1",
  };
}

/** Tinybars. 1 HBAR = 1e8 tinybars. */
const BASE_PRICE = 2_000_000n;

/**
 * Meter a GraphQL query by complexity: nesting depth plus field count.
 * Exported so the hermetic suite can assert per-call metering directly.
 */
export function quote(query: string): bigint {
  const depth = (query.match(/\{/g) ?? []).length;
  const fields = (query.match(/\w+(?=\s*[\{\n])/g) ?? []).length;
  return BASE_PRICE + BigInt(depth) * 500_000n + BigInt(fields) * 100_000n;
}

export async function buildService(cfg: ServiceConfig): Promise<Server> {
  const resourceServer = new x402ResourceServer(
    new HTTPFacilitatorClient({ url: cfg.facilitatorUrl })
  );
  resourceServer.register(SERVICE_NETWORK, new ExactHederaScheme());
  const routes: RoutesConfig = {
    "GET /analytics": {
      accepts: {
        scheme: "exact",
        network: SERVICE_NETWORK,
        payTo: cfg.payTo,
        // Metered: every query is priced by its own complexity at 402 time.
        // The same function runs again when the paid request arrives, so a
        // client that changes the query between 402 and payment is priced
        // for what it actually asked.
        price: (ctx) => {
          const raw = ctx.adapter.getQueryParams?.()?.["q"];
          const q = (Array.isArray(raw) ? raw[0] : raw) ?? "{ agents { id } }";
          return { asset: HBAR_ASSET_ID, amount: quote(q).toString() };
        },
        maxTimeoutSeconds: 60,
      },
      description: "Subgraph analytics — metered by complexity",
    },
    "GET /usdc-analytics": {
      accepts: {
        scheme: "exact",
        network: SERVICE_NETWORK,
        payTo: cfg.payTo,
        price: { asset: CIRCLE_HEDERA_TESTNET_USDC_HTS, amount: "10000" },
        maxTimeoutSeconds: 60,
      },
      description: "Subgraph analytics — Circle HTS USDC exact@hedera:testnet",
    },
  };
  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  await assertFacilitatorKinds(cfg.facilitatorUrl, [`exact@${SERVICE_NETWORK}`]);
  await httpServer.initialize();

  const journal = new Journal(cfg.journalPath ?? "./state/hedera-service/merchant.sqlite");
  const server = createServer((req, res) => {
    void handlePaidRequest({ req, res, httpServer, journal,
      prepare: request => liveAnalyticsBody(request.query, {}, { fetchRows: cfg.fetchRows, source: request.source }),
    }).catch(e => {
      console.error("Merchant handler failed:", e instanceof Error ? e.message : String(e));
      if (!res.headersSent) res.writeHead(503, { "content-type": "application/json" });
      res.end('{"error":"Merchant could not persist the request outcome"}');
    });
  });
  server.on("close", () => journal.close());
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const boot: ServiceConfig = await loadConfig().catch((e: unknown): never => {
    console.error(`Cannot start paid service: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
  const server = await buildService(boot).catch((e: unknown): never => {
    console.error(`Cannot start paid service: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
  server.listen(boot.port, boot.host, () =>
    console.log(`paid service on ${boot.host}:${(server.address() as { port: number }).port} (facilitator ${boot.facilitatorUrl})`)
  );
}
