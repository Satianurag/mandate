/**
 * Paid 200 bodies: live Agent0 rows, never a hardcoded demo agent.
 *
 * Uses the same GraphQL selection `reputation.ts` already uses against a
 * subgraph ID that MCP discovery resolved (or an explicit test injection).
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_QUERY, queryAgent0, resolveDiscoveredSubgraphs } from "./reputation.ts";
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
  totalFeedback: string;
  sampleMean: number | null;
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
  const query = opts.query ?? AGENT0_SAMPLE_QUERY;
  const body = await queryAgent0(subgraphId, apiKey, query, undefined, fetchFn);
  const agents = (body as { agents?: Raw[] })?.agents ?? [];
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
  const live = (agent.feedback ?? [])
    .filter((f) => !f.isRevoked)
    .map((f) => Number(f.value))
    .filter((n) => Number.isFinite(n));
  return {
    id: agent.id,
    agentId: agent.agentId,
    agentWallet: agent.agentWallet,
    totalFeedback: agent.totalFeedback,
    sampleMean: live.length ? live.reduce((a, b) => a + b, 0) / live.length : null,
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
    ...Object.keys(subgraphs),
  ].filter((c, i, a) => subgraphs[c] && a.indexOf(c) === i);
  if (preferred.length === 0) throw new Error("MCP discovery returned no Agent0 deployments.");

  let lastErr: Error | undefined;
  for (const chain of preferred) {
    const subgraphId = subgraphs[chain]!;
    try {
      const rows = await fetchAgent0Rows(subgraphId, apiKey, {
        fetchFn: deps.fetchFn,
        query: AGENT0_SAMPLE_QUERY,
      });
      if (rows.length === 0) {
        lastErr = new Error(`Agent0 ${chain} (${subgraphId}) returned zero rows.`);
        continue;
      }
      return analyticsPayload(query, { chain, subgraphId }, rows, paid);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastErr = e instanceof Error ? e : new Error(msg);
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
  return { ok: true, query, source, paid, rows };
}
