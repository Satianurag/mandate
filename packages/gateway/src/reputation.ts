/**
 * Counterparty judgment, via The Graph.
 *
 * Before Mandate authorises a payment it asks the question no stock x402
 * client asks: who am I about to pay, and what is their record?
 *
 * The answer comes from the Agent0 subgraphs, which index the ERC-8004
 * Identity, Reputation and Validation registries across Base, BNB Chain,
 * Ethereum, Monad and Polygon under one GraphQL schema. Because the schema is
 * standardised across chains, the same query works everywhere -- we do not
 * hand-write a per-chain integration.
 *
 * Docs:  https://thegraph.com/docs/en/subgraphs/existing-subgraphs/agent0/
 * MCP:   https://subgraphs.mcp.thegraph.com/sse (F30)
 */

import { HEDERA_ENTITY_ID_REGEX } from "@x402/hedera";
import type { CounterpartyReputation } from "./types.ts";

const GATEWAY = "https://gateway.thegraph.com/api";
// Current canonical mirror endpoints. NOT the stock `@x402/hedera` mirror
// constants -- those still point at the legacy `*-public` hosts.
const HEDERA_MIRRORS: Record<string, string> = {
  "hedera:mainnet": "https://mainnet.mirrornode.hedera.com/api/v1",
  "hedera:testnet": "https://testnet.mirrornode.hedera.com/api/v1",
  "hedera:previewnet": "https://previewnet.mirrornode.hedera.com/api/v1",
};
/** Entity-id shape, stock from `@x402/hedera` — identical to the hand-rolled regex this replaces. */
const HEDERA_ID_RE = HEDERA_ENTITY_ID_REGEX;

type FetchFn = typeof fetch;

export interface LookupOptions {
  /** CAIP-2 network of the payment; selects the Hedera mirror for alias resolution. */
  network?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: FetchFn;
  /**
   * Already-discovered Agent0 deployments. Production omits this and
   * resolves IDs through Subgraph MCP. Tests inject a fixture so the suite
   * stays hermetic (no MCP, no network).
   */
  subgraphs?: Record<string, string>;
}

/**
 * Resolve a Hedera account ID (0.0.x) to its EVM address alias via the
 * mirror node, so ERC-8004 reputation (keyed by EVM wallet) can be read for
 * Hedera-native payees. Without this, every Hedera payment resolves to
 * "unregistered" and escalates — the metered-query path could never `allow`.
 *
 * Returns null when the account exists but carries no EVM alias. THROWS when
 * the mirror itself cannot be read, so the caller records a coverage failure
 * rather than a clean "unregistered".
 */
export async function resolveHederaEvmAddress(
  accountId: string,
  mirrorBase: string,
  fetchFn: FetchFn = fetch
): Promise<string | null> {
  const res = await fetchFn(`${mirrorBase}/accounts/${accountId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Hedera mirror: HTTP ${res.status} for ${accountId}`);
  const body = (await res.json().catch(() => null)) as { evm_address?: string } | null;
  if (!body) throw new Error(`Hedera mirror: unparseable response for ${accountId}`);
  return typeof body.evm_address === "string" && body.evm_address.startsWith("0x")
    ? body.evm_address.toLowerCase()
    : null;
}

/**
 * Last-known Agent0 deployments, observed 2026-09-08 (F12). This table is
 * a FINDINGS observation and a hermetic-test fixture — production resolution
 * goes through Subgraph MCP (`discoverAgent0Deployments`). Do not use these
 * IDs as a silent runtime fallback; an empty MCP result must fail closed.
 */
export const AGENT0_TESTNET: Record<string, string> = {
  "base-sepolia": "4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u",
  "ethereum-sepolia": "6wQRC7geo9XYAhckfmfo8kbMRLeWU8KQd3XsJqFKmZLT",
  "bsc-chapel": "BTjind17gmRZ6YhT9peaCM13SvWuqztsmqyfjpntbg3Z",
  "monad-testnet": "8iiMH9sj471jbp7AwUuuyBXvPJqCEsobuHBeUEKQSxhU",
};

export const AGENT0_MAINNET: Record<string, string> = {
  ethereum: "FV6RR6y13rsnCxBAicKuQEwDp8ioEGiNaWaZUmvr1F8k",
  base: "43s9hQRurMGjuYnC1r2ZwS6xSQktbFyXMPMqGKUFJojb",
  bsc: "D6aWqowLkWqBgcqmpNKXuNikPkob24ADXCciiP8Hvn1K",
  polygon: "9q16PZv1JudvtnCAf44cBoxg82yK9SSsFvrjCY9xnneF",
  monad: "4tvLxkczjhSaMiqRrCV1EyheYHyJ7Ad8jub1UUyukBjg",
};

/** One schema is shared across every deployment, so the same query works on all. */
export const AGENT0_SUBGRAPHS: Record<string, string> = {
  ...AGENT0_TESTNET,
  ...AGENT0_MAINNET,
};

/**
 * Field names verified by schema introspection against the live subgraph on
 * 2026-09-08. Two were wrong in the first draft and would have failed at
 * runtime: the collection is `feedback` (singular, not `feedbacks`) and the
 * revocation flag is `isRevoked` (not `revoked`). `value` is a BigDecimal.
 *
 * `first: 100` samples the most recent feedback rather than reading all of it:
 * the busiest agent on Base carries 312,558 entries, so a full scan is neither
 * possible nor useful. A recency-weighted sample is also the more honest
 * signal -- an agent that behaved well two years ago and badly last week
 * should not average out to fine.
 */
export const AGENT_QUERY = /* GraphQL */ `
  query CounterpartyRecord($wallet: Bytes!) {
    agents(where: { agentWallet: $wallet }, first: 1) {
      id
      agentId
      agentWallet
      totalFeedback
      feedback(first: 100, orderBy: createdAt, orderDirection: desc) {
        value
        isRevoked
      }
      validations(first: 50) {
        response
        status
      }
    }
  }
`;

interface RawAgent {
  id: string;
  agentId: string | null;
  /** Nullable in real data -- some registered agents carry no wallet. */
  agentWallet: string | null;
  totalFeedback: string;
  feedback: { value: string; isRevoked: boolean }[];
  validations: { response: number | null; status: string }[];
}

/**
 * Resolve an ERC-8004 record for the account we are about to pay.
 *
 * SECURITY: every chain is queried and the results are POOLED. An earlier
 * version returned the first chain where the agent was registered, which is a
 * reputation-laundering vector -- and not a theoretical one. Wallet
 * 0xf9d1d63f…d5f1 is registered on both Ethereum (0 feedback) and Base (100
 * feedback); first-wins picked Ethereum and reported a well-rated agent as
 * unrated. An adversary with bad history on one chain need only register on a
 * quiet one to look clean.
 *
 * Pooling every entry across every deployment means adding a fresh empty
 * registration cannot dilute an existing bad record below the refusal floor;
 * it only adds zero entries to the pool. Revocations are summed across chains
 * for the same reason.
 */
export async function lookupCounterparty(
  payTo: string,
  apiKey: string,
  opts: LookupOptions = {}
): Promise<CounterpartyReputation> {
  const fetchFn = opts.fetchFn ?? fetch;
  const subgraphs = opts.subgraphs ?? (await resolveDiscoveredSubgraphs(apiKey));
  const entries = Object.entries(subgraphs);
  const fullCoverage = {
    chainsQueried: entries.length,
    chainsReachable: entries.length,
    chainsFailed: [] as string[],
  };

  // Hedera-native payees (0.0.x) are not EVM wallets. Resolve the EVM alias
  // first; ERC-8004 reputation is keyed by wallet address.
  let wallet = payTo.toLowerCase();
  if (HEDERA_ID_RE.test(payTo.trim())) {
    // Unknown networks throw rather than defaulting: resolving an alias
    // against the wrong network's mirror would attribute reputation to the
    // wrong account.
    const network = opts.network ?? "hedera:testnet";
    const mirror = HEDERA_MIRRORS[network];
    if (!mirror) throw new Error(`No Hedera mirror for network "${network}".`);
    let alias: string | null;
    try {
      alias = await resolveHederaEvmAddress(payTo.trim(), mirror, fetchFn);
    } catch {
      // The mirror did not answer: zero registries were read, and the audit
      // record must say so rather than reporting a clean "unregistered".
      return {
        registered: false,
        feedbackCount: 0,
        meanScore: null,
        revokedCount: 0,
        validationCount: 0,
        chainsQueried: entries.length,
        chainsReachable: 0,
        chainsFailed: ["hedera-mirror"],
      };
    }
    if (!alias) {
      // Account exists but has no EVM alias: genuinely no ERC-8004 identity.
      return {
        registered: false,
        feedbackCount: 0,
        meanScore: null,
        revokedCount: 0,
        validationCount: 0,
        ...fullCoverage,
      };
    }
    wallet = alias;
  }

  const settled = await Promise.allSettled(
    entries.map(async ([chain, id]) => {
      const agent = await queryAgent(id, wallet, apiKey, fetchFn);
      return { chain, agent };
    })
  );

  const found: { chain: string; agent: RawAgent }[] = [];
  const failed: string[] = [];
  settled.forEach((r, i) => {
    const chain = entries[i]![0];
    if (r.status === "rejected") {
      failed.push(chain);
    } else if (r.value.agent) {
      found.push({ chain, agent: r.value.agent });
    }
  });

  // Measured 2026-09-08: 3 of 9 deployments (monad, monad-testnet,
  // ethereum-sepolia) return "bad indexers" even on retry. Those failures used
  // to be dropped silently, which is the same laundering vector as F15 through
  // a different door.
  const coverage = {
    chainsQueried: entries.length,
    chainsReachable: entries.length - failed.length,
    chainsFailed: failed.sort(),
  };

  if (found.length === 0) {
    return {
      registered: false,
      feedbackCount: 0,
      meanScore: null,
      revokedCount: 0,
      validationCount: 0,
      ...coverage,
    };
  }

  const live: number[] = [];
  let revoked = 0;
  let validations = 0;
  for (const { agent } of found) {
    for (const f of agent.feedback) {
      if (f.isRevoked) revoked += 1;
      else {
        const v = Number(f.value);
        if (Number.isFinite(v)) live.push(v);
      }
    }
    validations += agent.validations.length;
  }

  // ERC-8004 feedback values run 0-100 (confirmed against live Base data:
  // observed means from 1.0 to 100.0). Normalise to 0..1 so the policy engine
  // compares on one scale regardless of the registry's units.
  const meanScore =
    live.length > 0
      ? clamp01(live.reduce((a, b) => a + b, 0) / live.length / 100)
      : null;

  return {
    agentId: found[0]!.agent.id,
    registered: true,
    feedbackCount: live.length,
    meanScore,
    revokedCount: revoked,
    validationCount: validations,
    chain: found.map((f) => f.chain).sort().join("+"),
    ...coverage,
  };
}

async function queryAgent(
  subgraphId: string,
  wallet: string,
  apiKey: string,
  fetchFn: FetchFn = fetch
): Promise<RawAgent | null> {
  const data = (await queryAgent0(subgraphId, apiKey, AGENT_QUERY, { wallet }, fetchFn)) as {
    agents?: RawAgent[];
  };
  return data?.agents?.[0] ?? null;
}

/**
 * POST a GraphQL document to a discovered subgraph. The Graph returns HTTP
 * 200 even for auth failures — inspect the body, never `res.ok` alone (F4).
 */
export async function queryAgent0(
  subgraphId: string,
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
  fetchFn: FetchFn = fetch
): Promise<unknown> {
  const res = await fetchFn(`${GATEWAY}/subgraphs/id/${subgraphId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json().catch(() => null)) as
    | { data?: unknown; errors?: { message: string }[] }
    | null;
  if (!body) throw new Error(`Graph gateway: unparseable response (HTTP ${res.status})`);
  if (body.errors?.length) {
    throw new Error(`Graph gateway: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data;
}

let lastMcpToolsUsed: string[] = [];
/** Tool names the last MCP discovery actually called — printed by probe:reputation. */
export function getLastMcpToolsUsed(): string[] {
  return lastMcpToolsUsed;
}

let discoveredCache: Record<string, string> | null = null;

/**
 * Production subgraph ID source: Subgraph MCP. Tests never hit this because
 * they pass `opts.subgraphs`. An empty MCP result throws — it does not fall
 * back to AGENT0_SUBGRAPHS (that table is an observation, not a runtime default).
 */
export async function resolveDiscoveredSubgraphs(apiKey: string): Promise<Record<string, string>> {
  if (discoveredCache) return discoveredCache;
  const { discoverAgent0DeploymentsWithKey } = await import("./discovery.ts");
  const { subgraphs, toolsUsed } = await discoverAgent0DeploymentsWithKey(apiKey);
  lastMcpToolsUsed = toolsUsed;
  discoveredCache = subgraphs;
  return subgraphs;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
