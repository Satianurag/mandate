/**
 * Paid 200 bodies: live Agent0 rows, never a hardcoded demo agent.
 *
 * Uses the same GraphQL selection `reputation.ts` already uses against a
 * subgraph ID that MCP discovery resolved (or an explicit test injection).
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_QUERY, queryAgent0, resolveDiscoveredSubgraphs } from "./reputation.ts";
import { validateAnalyticsQuery } from "./query-scope.ts";
import { withSecret } from "./keyring.ts";

export { AGENT_QUERY };

export const AGENT0_SAMPLE_QUERY = /* GraphQL */ `
  query AnalyticsSample {
    agents(first: 5, orderBy: totalFeedback, orderDirection: desc) {
      id
      agentId
      agentWallet
      totalFeedback
      feedback(first: 8, orderBy: createdAt, orderDirection: desc) {
        value
        isRevoked
      }
    }
  }
`;

export interface Agent0Row {
  id: string;
  agentId: string | null;
  agentWallet: string | null;
  totalFeedback: string | null;
  sampleMean: number | null;
  measurements?: Array<{value: string; isRevoked: boolean}>;
}

export interface AnalyticsPayload {
  ok: true;
  query: string;
  source: { chain: string; subgraphId: string };
  rows: Agent0Row[];
}

type FetchFn = typeof fetch;

/**
 * Fetch a real Agent0 sample from a discovered subgraph. Throws when the
 * gateway returns errors (never collapses that into a fake row).
 */
export async function fetchAgent0Rows(
  subgraphId: string,
  apiKey: string,
  opts: { fetchFn?: FetchFn; query?: string } = {}
): Promise<Agent0Row[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const query = validateAnalyticsQuery(opts.query ?? AGENT0_SAMPLE_QUERY);
  const body = await queryAgent0(subgraphId, apiKey, query, undefined, fetchFn);
  const agents = (body as { agents?: Raw[] })?.agents ?? [];
  if (!Array.isArray(agents)) throw new Error("Graph response agents must be a collection");
  return agents.map(toRow);
}

interface Raw {
  id: string;
  agentId: string | null;
  agentWallet: string | null;
  totalFeedback: string;
  feedback?: { value: string; isRevoked: boolean }[];
}

function toRow(agent: Raw): Agent0Row {
  return {
    id: agent.id,
    agentId: agent.agentId ?? null,
    agentWallet: agent.agentWallet ?? null,
    totalFeedback: agent.totalFeedback ?? null,
    // Measurements can have incompatible units and scales. Never average them into a trust score.
    sampleMean: null,
    measurements: (agent.feedback ?? []).map(f => ({value:String(f.value),isRevoked:f.isRevoked})),
  };
}

/** Unseal the Graph Studio key. Null when this host has no sealed blob. */
export async function loadSealedGraphKey(): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const path = process.env.MANDATE_GRAPH_KEY_ENC ?? join(root, "secrets/graph.enc");
  const enc = await readFile(path).catch(() => null);
  if (!enc) return null;
  return withSecret("graph-gateway", enc, (b) => Promise.resolve(b.toString("utf8").trim()));
}

/**
 * Body of a paid 200. Never returns a placeholder row — missing key or empty
 * discovery fails instead of inventing `agent-demo-1`.
 */
export async function liveAnalyticsBody(
  query: string,
  paid: Record<string, unknown>,
  deps: {
    apiKey?: string | null;
    subgraphs?: Record<string, string>;
    fetchFn?: FetchFn;
    fetchRows?: (query: string) => Promise<Agent0Row[]>;
  } = {}
): Promise<Record<string, unknown>> {
  validateAnalyticsQuery(query);
  if (deps.fetchRows) {
    const rows = await deps.fetchRows(query);
    return analyticsPayload(query, { chain: "test", subgraphId: "injected" }, rows, paid);
  }
  const apiKey = deps.apiKey === undefined ? await loadSealedGraphKey() : deps.apiKey;
  if (!apiKey) {
    throw new Error("Graph API key is not sealed — paid analytics cannot invent rows.");
  }
  const subgraphs = deps.subgraphs ?? (await resolveDiscoveredSubgraphs(apiKey));
  const preferred = [
    "base-sepolia",
    "ethereum-sepolia",
    "bsc-chapel",
    "monad-testnet",
  ].filter((c, i, a) => subgraphs[c] && a.indexOf(c) === i);
  if (preferred.length === 0) throw new Error("MCP discovery returned no Agent0 deployments.");

  let lastErr: Error | undefined;
  const attempts: Array<{chain:string;status:string;error?:string}> = [];
  for (const chain of preferred) {
    const subgraphId = subgraphs[chain]!;
    try {
      const data = await queryAgent0(subgraphId, apiKey, query, undefined, deps.fetchFn);
      if (!data || typeof data !== "object") throw new Error("Graph returned no query data");
      const raw = data as {agents?:Raw[];_meta?:unknown};
      if (raw.agents !== undefined && !Array.isArray(raw.agents)) throw new Error("Graph agents is not a collection");
      attempts.push({chain,status:"available"});
      return {...analyticsPayload(query, {chain,subgraphId}, (raw.agents ?? []).map(toRow), paid),
        data, sourceMetadata:raw._meta ?? null, sourceAttempts:attempts};
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastErr = e instanceof Error ? e : new Error(msg);
      attempts.push({chain,status:"unavailable",error:msg});
      if (/subgraph not found|bad indexers/i.test(msg)) continue;
      throw e;
    }
  }
  throw lastErr ?? new Error("MCP discovery returned no reachable Agent0 deployments.");
}

export function analyticsPayload(
  query: string,
  source: { chain: string; subgraphId: string },
  rows: Agent0Row[],
  paid: Record<string, unknown>
): Record<string, unknown> {
  return { ok: true, query, source, observedAt: new Date().toISOString(),
    reputation: { advisoryOnly: true, reviewersFiltered: false, measurementSchema: "unspecified", warning: "Feedback counts and raw sample values are not spending authority or a comparable trust score." },
    paid, rows };
}
