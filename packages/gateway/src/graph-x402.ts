/**
 * Graph x402 testnet adapter.
 *
 * `@graphprotocol/client-x402` is the payment client Graph publishes; it
 * wants a `privateKey` / `X402_PRIVATE_KEY`. We never put a key in env
 * (invariant 1). Settlement uses stock `ExactEvmScheme` with a Key Ring or
 * Ledger signer — the same exact rail Graph's 402 advertises.
 *
 * Live host is `gateway.testnet.thegraph.com` (F8). Docs print the hostname
 * backwards. Production `gateway.thegraph.com` bills mainnet even for a
 * Sepolia subgraph (F31); this module refuses that challenge.
 */

import { wrapFetchWithPayment } from "@x402/fetch";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { x402Client } from "@x402/core/client";
import type { ClientEvmSigner } from "@x402/evm";
import {
  GRAPH_X402_TESTNET,
  isSepoliaX402Challenge,
  parseChallenge,
  queryOrChallenge,
  type GraphChallenge,
} from "./graph.ts";
import { createEvmX402Client } from "./evm-client.ts";

export interface GraphX402QueryResult {
  data: unknown;
  settlementId?: string;
  network: string;
  gateway: string;
}

export async function probeGraphX402Testnet(subgraphId: string): Promise<
  { ok: true; challenge: GraphChallenge } | { ok: false; reason: string }
> {
  try {
    const r = await queryOrChallenge(subgraphId, "{ _meta { block { number } } }", {
      base: GRAPH_X402_TESTNET,
    });
    if (r.kind === "challenge") {
      if (!isSepoliaX402Challenge(r.challenge)) {
        const net = r.challenge.accepts[0]?.network ?? "unknown";
        return {
          ok: false,
          reason: `testnet gateway advertised ${net}, not Base Sepolia (F31)`,
        };
      }
      return { ok: true, challenge: r.challenge };
    }
    if (r.kind === "data") {
      return {
        ok: false,
        reason: "testnet gateway returned data without a 402 — unexpected for x402 PoI",
      };
    }
    return { ok: false, reason: r.message };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : "";
    return { ok: false, reason: `${msg}${cause ? ` (${cause})` : ""}` };
  }
}

/**
 * Pay a Graph testnet x402 challenge with a Ledger / Key Ring EVM signer.
 * Throws when the testnet host is down or bills mainnet — never retries
 * against production.
 */
export async function queryGraphX402Testnet(
  subgraphId: string,
  query: string,
  opts: { signer: ClientEvmSigner; rpcUrl: string; x402?: x402Client }
): Promise<GraphX402QueryResult> {
  const probe = await probeGraphX402Testnet(subgraphId);
  if (!probe.ok) {
    throw new Error(`FINDING F8: Graph x402 testnet unavailable: ${probe.reason}`);
  }
  const x402 =
    opts.x402 ??
    createEvmX402Client({
      signer: opts.signer,
      rpcUrl: opts.rpcUrl,
      chainId: 84532,
    });
  const endpoint = `${GRAPH_X402_TESTNET}/subgraphs/id/${subgraphId}`;
  const paid = await wrapFetchWithPayment(fetch, x402)(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await paid.text();
  if (paid.status !== 200) {
    throw new Error(`Graph x402 paid query failed: HTTP ${paid.status} ${text.slice(0, 400)}`);
  }
  const body = JSON.parse(text) as { data?: unknown; errors?: { message: string }[] };
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  let settlementId: string | undefined;
  const pr = paid.headers.get("payment-response");
  if (pr) {
    try {
      settlementId = decodePaymentResponseHeader(pr).transaction;
    } catch {
      /* Graph may omit a stock payment-response; data+200 still proves access */
    }
  }
  return {
    data: body.data,
    settlementId,
    network: probe.challenge.accepts[0]?.network ?? "eip155:84532",
    gateway: GRAPH_X402_TESTNET,
  };
}

export { parseChallenge };
