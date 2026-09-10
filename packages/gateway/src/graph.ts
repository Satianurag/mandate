/**
 * The Graph's x402 gateway.
 *
 * This gateway does NOT follow the shape most x402 clients assume, and the
 * deviations were found by probing it live on 2026-09-08. All three matter:
 *
 *   1. The 402 response body is ZERO BYTES. Payment requirements arrive in a
 *      base64-encoded `payment-required` RESPONSE HEADER.
 *   2. The retry header is `Payment-Signature`, not `X-PAYMENT`.
 *      (Its own error text says so: "Payment-Signature header is required".)
 *   3. The authenticated gateway returns HTTP 200 WITH AN ERROR BODY for auth
 *      failures -- `{"errors":[{"message":"auth error: ..."}]}`. Never branch
 *      on res.ok alone against The Graph; always inspect the body.
 *
 * Observed challenge (production, mainnet):
 *   scheme  exact          network eip155:8453 (Base mainnet)
 *   amount  10000          = 0.01 USDC (6dp)
 *   asset   0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  (USDC on Base)
 *   payTo   0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB
 *   extra   { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" }
 *
 * IMPORTANT: the gateway offers ONLY the `exact` scheme. It cannot accept
 * batch-settlement vouchers, so the mandate envelope runs against our own
 * service on Base Sepolia. See docs/architecture.md.
 *
 * `@graphprotocol/client-x402` and Graph docs list the testnet host as
 * `testnet.gateway.thegraph.com`. That name is NXDOMAIN (F8). The live
 * host is the subdomain swap `gateway.testnet.thegraph.com`, which
 * returns x402 v2 on Base Sepolia (`eip155:84532`). Production
 * `gateway.thegraph.com` still bills `eip155:8453` even for a Sepolia
 * subgraph ID (F31) — we never pay that challenge.
 */

export const GRAPH_X402_PRODUCTION = "https://gateway.thegraph.com/api/x402";
/** Hostname printed in Graph docs / client-x402 README. NXDOMAIN (F8). */
export const GRAPH_X402_TESTNET_DOCUMENTED = "https://testnet.gateway.thegraph.com/api/x402";
/** Live Graph testnet x402 gateway (Base Sepolia USDC). */
export const GRAPH_X402_TESTNET = "https://gateway.testnet.thegraph.com/api/x402";
/**
 * Subgraph published on Graph Network *testnet* with live indexer allocations
 * (F34). Agent0 Base Sepolia (`4yYAvQLF…`) lives on the production Graph
 * Network; the testnet x402 gateway 402s it, then returns subgraph-not-found
 * after payment.
 */
export const GRAPH_X402_TESTNET_SUBGRAPH = "ErqkB52VhmToVRxAWLaJ3cTDiwQMk93VKDEGtSSDB1yP";
export const GRAPH_GATEWAY_AUTHENTICATED = "https://gateway.thegraph.com/api";

export interface GraphChallenge {
  x402Version: number;
  error?: string;
  resource?: { url: string };
  accepts: {
    scheme: string;
    network: string;
    amount: string;
    payTo: string;
    asset: string;
    maxTimeoutSeconds: number;
    extra?: Record<string, unknown>;
  }[];
}

/** Decode the base64 `payment-required` header into a challenge. */
export function parseChallenge(headers: Headers): GraphChallenge | null {
  const raw = headers.get("payment-required");
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as GraphChallenge;
  } catch {
    return null;
  }
}

/** True when the 402 is the testnet rail (Base Sepolia), not mainnet USDC. */
export function isSepoliaX402Challenge(challenge: GraphChallenge): boolean {
  const net = challenge.accepts[0]?.network;
  return net === "eip155:84532" || net === "base-sepolia";
}

/**
 * Query the x402 gateway. Returns either the data, or the challenge to pay.
 * Deliberately does not pay -- the policy engine decides that.
 */
export async function queryOrChallenge(
  subgraphId: string,
  query: string,
  opts: { base?: string; paymentSignature?: string } = {}
): Promise<
  | { kind: "data"; data: unknown }
  | { kind: "challenge"; challenge: GraphChallenge }
  | { kind: "error"; message: string }
> {
  const base = opts.base ?? GRAPH_X402_PRODUCTION;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.paymentSignature) headers["Payment-Signature"] = opts.paymentSignature;

  const res = await fetch(`${base}/subgraphs/id/${subgraphId}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });

  if (res.status === 402) {
    const challenge = parseChallenge(res.headers);
    return challenge
      ? { kind: "challenge", challenge }
      : { kind: "error", message: "402 with no decodable payment-required header" };
  }

  // The Graph returns 200 even for auth errors. Check the body, not the status.
  const body = (await res.json().catch(() => null)) as
    | { data?: unknown; errors?: { message: string }[] }
    | null;
  if (!body) return { kind: "error", message: `unparseable response (HTTP ${res.status})` };
  if (body.errors?.length) {
    return { kind: "error", message: body.errors.map((e) => e.message).join("; ") };
  }
  return { kind: "data", data: body.data };
}
