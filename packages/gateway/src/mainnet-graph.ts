/** Reviewed Graph sources for the submitted mainnet workspace. Deployments are discovered, never guessed at payment time. */
import { withSealedGraphKey } from "./analytics.ts";
import { discoverAgent0DeploymentsWithKey, discoverKeywordDeployments } from "./discovery.ts";
import type { GraphToolSource } from "./agent-tools.ts";
import type { ResearchSourceScope } from "./research-task.ts";

export const UNISWAP_V3_BASE_QUERIES: GraphToolSource["queries"] = [
  { id: "overview", description: "Factory TVL and activity snapshot", query: "{ factories(first:1) { id poolCount txCount totalValueLockedUSD } _meta { block { number } hasIndexingErrors } }" },
  { id: "activity", description: "Complete-day volume history", query: "{ uniswapDayDatas(first:10,orderBy:date,orderDirection:desc) { date volumeUSD tvlUSD } _meta { block { number } hasIndexingErrors } }" },
  { id: "pools", description: "Highest-TVL pools in the bounded sample", query: "{ pools(first:10,orderBy:totalValueLockedUSD,orderDirection:desc) { id token0 { symbol } token1 { symbol } totalValueLockedUSD volumeUSD } _meta { block { number } hasIndexingErrors } }" },
];

export async function resolveMainnetGraphSources(): Promise<{
  agent0?: { endpoint: string; source: ResearchSourceScope; detailed: true };
  protocols?: GraphToolSource[];
}> {
  return withSealedGraphKey(async key => {
    const discovered = await discoverAgent0DeploymentsWithKey(key);
    const baseId = discovered.subgraphs.base;
    const agent0 = baseId ? {
      endpoint: `https://gateway.thegraph.com/api/x402/subgraphs/id/${baseId}`,
      source: { provider: "the-graph" as const, chain: "base" as const, deployment: baseId },
      detailed: true as const,
    } : undefined;
    let protocolId = process.env.MANDATE_UNISWAP_V3_BASE_SUBGRAPH?.trim();
    if (!protocolId) {
      try { protocolId = (await discoverKeywordDeployments(key, "Uniswap V3 Base")).subgraphs.base; } catch { /* Protocol source is optional. */ }
    }
    if (!protocolId) {
      try { protocolId = (await discoverKeywordDeployments(key, "Uniswap V3")).subgraphs.base; } catch { /* Protocol source is optional. */ }
    }
    const protocols = protocolId ? [{
      id: "uni-base",
      label: "Uniswap V3 Base",
      endpoint: `https://gateway.thegraph.com/api/x402/subgraphs/id/${protocolId}`,
      queries: UNISWAP_V3_BASE_QUERIES,
    }] : undefined;
    return { agent0, protocols };
  });
}
