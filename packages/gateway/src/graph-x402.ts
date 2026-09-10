/**
 * Graph x402 testnet adapter.
 *
 * `@graphprotocol/client-x402` is the payment client; the signer is a Key Ring
 * session key passed in-process — never `X402_PRIVATE_KEY` in the environment
 * (invariant 1). The documented testnet host was NXDOMAIN on 8 Sep and still
 * NXDOMAIN on 10 Sep (F8). Calling `queryGraphX402Testnet` probes the host
 * first and throws a FINDING rather than falling through to mainnet USDC (F31).
 */

import { GRAPH_X402_TESTNET, parseChallenge, queryOrChallenge, type GraphChallenge } from "./graph.ts";
import { withSecret } from "./keyring.ts";

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
      const net = r.challenge.accepts[0]?.network;
      if (net && net !== "eip155:84532" && net !== "base-sepolia") {
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
 * Pay a Graph testnet x402 challenge with a Key Ring session key.
 * Throws when the testnet host is down — callers must record a FINDING, not
 * retry against production/mainnet.
 */
export async function queryGraphX402Testnet(
  subgraphId: string,
  query: string,
  sealedSessionKey: Buffer,
  sessionKeyName = "mandate-session"
): Promise<GraphX402QueryResult> {
  const probe = await probeGraphX402Testnet(subgraphId);
  if (!probe.ok) {
    throw new Error(`FINDING F8: Graph x402 testnet unavailable: ${probe.reason}`);
  }
  const { createGraphQuery } = await import("@graphprotocol/client-x402");
  return withSecret(sessionKeyName, sealedSessionKey, async (key) => {
    const hex = key.toString("hex");
    const privateKey = hex.startsWith("0x") ? hex : `0x${hex}`;
    const endpoint = `${GRAPH_X402_TESTNET}/subgraphs/id/${subgraphId}`;
    const run = createGraphQuery({
      endpoint,
      chain: "base-sepolia",
      privateKey,
    });
    const result = (await run(query)) as { data?: unknown; errors?: { message: string }[] };
    if (result?.errors?.length) {
      throw new Error(result.errors.map((e) => e.message).join("; "));
    }
    return {
      data: result.data,
      network: probe.challenge.accepts[0]?.network ?? "eip155:84532",
      gateway: GRAPH_X402_TESTNET,
    };
  });
}

export { parseChallenge };
