/**
 * Live discovery: Agent0 subgraph IDs via Subgraph MCP, facilitator kinds
 * via `/supported`. Nothing here is a pinned table that can rot.
 */

import { HTTPFacilitatorClient } from "@x402/core/http";
import { openSubgraphMcp, type McpClient, type McpTool } from "./mcp.ts";

const SUBGRAPH_ID_RE = /\b[A-Za-z0-9]{40,50}\b/g;

const CHAIN_ALIASES: Array<[RegExp, string]> = [
  [/base[_\s-]*sepolia|basesepolia/i, "base-sepolia"],
  // MCP sometimes truncates "base-sepolia" to "base-8"; must beat the generic `base` rule.
  [/base[_\s-]*8\b|chainid[:\s]*84532|\b84532\b/i, "base-sepolia"],
  [/ethereum[_\s-]*sepolia|eth[_\s-]*sepolia/i, "ethereum-sepolia"],
  [/bsc[_\s-]*chapel|bnb[_\s-]*chapel|chapel|bsc[_\s-]*test/i, "bsc-chapel"],
  [/monad[_\s-]*test/i, "monad-testnet"],
  [/base[_\s-]*mainnet/i, "base"],
  [/\bpolygon\b/i, "polygon"],
  [/ethereum[_\s-]*mainnet|agent0-mainnet/i, "ethereum"],
  [/\bethereum\b(?![_\s-]*sepolia)/i, "ethereum"],
  [/\bbase\b(?![_\s-]*sepolia)/i, "base"],
  [/\bbsc\b|\bbnb\b/i, "bsc"],
  [/\bmonad\b(?![_\s-]*test)/i, "monad"],
];

export interface DiscoveryResult {
  subgraphs: Record<string, string>;
  toolsUsed: string[];
}

const DISCOVERY_ARG_SET = new Set(["keyword", "query", "search", "q", "text"]);

function canSatisfyFromKeyword(tool: McpTool): boolean {
  const name = tool.name.toLowerCase();
  if (name.includes("ipfs")) return false;
  const required = tool.inputSchema?.required ?? [];
  return required.every((r) => DISCOVERY_ARG_SET.has(r));
}

/**
 * Resolve Agent0 deployments at runtime through MCP tools.
 * Throws when MCP answers but yields no subgraph IDs — that is a failed
 * discovery, not a license to fall back to a hardcoded table.
 */
export async function discoverAgent0Deployments(
  mcp: McpClient
): Promise<DiscoveryResult> {
  const tools = await mcp.listTools();
  if (tools.length === 0) {
    throw new Error("Subgraph MCP advertised zero tools.");
  }
  const toolsUsed: string[] = [];
  const searchable = tools.filter(canSatisfyFromKeyword);
  const search =
    searchable.find((t) => t.name.toLowerCase().includes("keyword")) ??
    searchable.find((t) => t.name.toLowerCase().includes("search_subgraphs")) ??
    searchable.find((t) =>
      ["search", "discover"].some((n) => t.name.toLowerCase().includes(n))
    );
  if (!search) {
    throw new Error(
      `Subgraph MCP has no keyword-search tool we can call (saw: ${tools
        .map((t) => `${t.name}[${(t.inputSchema?.required ?? []).join(",")}]`)
        .join("; ")})`
    );
  }
  toolsUsed.push(search.name);

  const args: Record<string, unknown> = {};
  const required = search.inputSchema?.required ?? [];
  const props = Object.keys(search.inputSchema?.properties ?? {});
  const fill = (name: string, value: unknown) => {
    if (!DISCOVERY_ARG_SET.has(name)) return;
    if (required.includes(name) || props.includes(name)) args[name] = value;
  };
  fill("keyword", "Agent0");
  fill("query", "Agent0");
  fill("search", "Agent0");
  fill("q", "Agent0");
  fill("text", "Agent0");
  if (Object.keys(args).length === 0) {
    args.keyword = "Agent0";
  }

  const raw = await mcp.callTool(search.name, args);

  const subgraphs = parseSubgraphs(raw);
  if (Object.keys(subgraphs).length === 0) {
    const byContract = tools.find(
      (t) =>
        canSatisfyFromKeyword(t) &&
        t.name !== search.name &&
        ["contract", "deployment", "top_subgraph"].some((n) => t.name.toLowerCase().includes(n))
    );
    if (byContract) {
      toolsUsed.push(byContract.name);
      const extra = await mcp.callTool(byContract.name, {
        keyword: "Agent0",
        query: "Agent0",
      });
      Object.assign(subgraphs, parseSubgraphs(extra));
    }
  }

  if (Object.keys(subgraphs).length === 0) {
    throw new Error(
      `Subgraph MCP tools [${tools.map((t) => t.name).join(", ")}] returned no Agent0 subgraph IDs.`
    );
  }
  return { subgraphs, toolsUsed };
}

export async function discoverAgent0DeploymentsWithKey(
  apiKey: string
): Promise<DiscoveryResult> {
  const mcp = await openSubgraphMcp(apiKey);
  try {
    return await discoverAgent0Deployments(mcp);
  } finally {
    await mcp.close();
  }
}

function parseSubgraphs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const parsed = JSON.parse(text) as {
      subgraphs?: Array<{ id?: string; metadata?: { displayName?: string } }>;
    };
    if (Array.isArray(parsed.subgraphs)) {
      let i = 0;
      for (const s of parsed.subgraphs) {
        if (typeof s.id !== "string" || !/^[A-Za-z0-9]{40,50}$/.test(s.id)) continue;
        const name = s.metadata?.displayName ?? "";
        let alias = CHAIN_ALIASES.find(([re]) => re.test(name))?.[1] ?? `subgraph-${i}`;
        if (out[alias]) alias = `subgraph-${i}`;
        out[alias] = s.id;
        i += 1;
      }
      if (Object.keys(out).length) return out;
    }
  } catch {
    /* not JSON — fall through to regex */
  }
  const ids = [...new Set(text.match(SUBGRAPH_ID_RE) ?? [])];
  let i = 0;
  for (const id of ids) {
    const idx = text.indexOf(id);
    const ctx = text.slice(Math.max(0, idx - 32), idx + id.length + 16);
    let alias = CHAIN_ALIASES.find(([re]) => re.test(ctx))?.[1] ?? `subgraph-${i}`;
    if (out[alias]) alias = `subgraph-${i}`;
    out[alias] = id;
    i += 1;
  }
  return out;
}

/** Live `/supported` kinds as `scheme@network` strings. */
export async function discoverFacilitatorKinds(url: string): Promise<string[]> {
  const client = new HTTPFacilitatorClient({ url });
  const supported = await client.getSupported();
  return supported.kinds.map((k) => `${k.scheme}@${k.network}`);
}

/**
 * Boot gate: refuse to serve when a required kind is missing from the live
 * advertisement. The kind list is a live fact, never a pinned constant.
 */
export async function assertFacilitatorKinds(url: string, required: string[]): Promise<string[]> {
  const kinds = await discoverFacilitatorKinds(url);
  const missing = required.filter((k) => !kinds.includes(k));
  if (missing.length) {
    throw new Error(
      `${url} missing required kinds ${missing.join(", ")} (saw: ${kinds.join(", ") || "none"})`
    );
  }
  return kinds;
}
