/** Approved endpoint adapters; model arguments can never supply a destination URL. */
import type { AgentToolId } from "./agent-profiles.ts";
import type { AgentTool } from "./agent-runtime.ts";
import { parse, Kind, visit } from "graphql";
import { compileResearchQuery, type ResearchSourceScope } from "./research-task.ts";

export interface AgentToolRequest { url: string; method: "GET" | "POST"; body?: string }
export interface AgentToolDefinition extends AgentTool {
  request(input: Record<string, unknown>): AgentToolRequest;
  sources(data: unknown): Array<{ url: string; title: string }>;
}
export interface GraphToolSource {
  id: string; label: string; endpoint: string;
  /** Queries verified against this deployment. The model selects a query ID, never fabricates its schema. */
  queries: Array<{ id: string; description: string; query: string }>;
}
export interface AgentToolConfiguration {
  agent0?: { endpoint: string; source: ResearchSourceScope };
  protocols?: GraphToolSource[];
  /** Explicit first-party testnet service URLs, not a claim that public vendors accept test tokens. */
  testnetEndpoints?: Partial<Record<AgentToolId, string>>;
}
function exactFields(input: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(input).some(k => !fields.includes(k))) throw new Error("Tool arguments contain an unsupported field");
}
function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must contain 1–${max} characters`);
  return value.trim();
}
function graphEndpoint(raw: string): string {
  const url = new URL(raw);
  if (url.origin !== "https://gateway.thegraph.com" || !/^\/api\/x402\/subgraphs\/id\/[A-Za-z0-9]+$/.test(url.pathname) || url.search || url.hash || url.username || url.password) throw new Error("Graph tool must use an explicitly reviewed production x402 deployment");
  return url.toString();
}
function validateConfiguredQuery(query: string): void {
  if (Buffer.byteLength(query) > 12000) throw new Error("Configured query exceeds 12 KB");
  const doc = parse(query, { maxTokens: 800 }), op = doc.definitions[0];
  if (doc.definitions.length !== 1 || op?.kind !== Kind.OPERATION_DEFINITION || op.operation !== "query" || op.variableDefinitions?.length) throw new Error("Configured protocol queries must be single read-only operations without variables");
  let depth = 0, count = 0;
  visit(doc, { FragmentSpread() { throw new Error("Fragments are not permitted"); }, InlineFragment() { throw new Error("Fragments are not permitted"); }, Directive() { throw new Error("Directives are not permitted"); }, Field: { enter(node) {
    if (++depth > 6 || ++count > 100 || node.name.value.startsWith("__")) throw new Error("Configured query exceeds the bounded data surface");
    for (const arg of node.arguments ?? []) if (["first", "last"].includes(arg.name.value) && (arg.value.kind !== Kind.INT || Number(arg.value.value) < 1 || Number(arg.value.value) > 100)) throw new Error("Pagination must be bounded to 1–100 records");
  }, leave() { depth--; } } });
}
export function observedSources(data: unknown): Array<{ url: string; title: string }> {
  const found = new Map<string, string>(); let visited = 0;
  function visit(v: unknown, depth: number): void {
    if (depth > 8 || ++visited > 5000 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { v.slice(0,100).forEach(x => visit(x, depth + 1)); return; }
    const row = v as Record<string, unknown>;
    const raw = row.url ?? row.link ?? row.source_url;
    if (typeof raw === "string") {
      try { const u = new URL(raw); if (u.protocol === "https:" && !u.username && !u.password) found.set(u.toString(), typeof row.title === "string" ? row.title.slice(0,300) : u.hostname); } catch { /* not a source URL */ }
    }
    Object.values(row).forEach(x => visit(x, depth + 1));
  }
  visit(data, 0); return [...found].slice(0,100).map(([url, title]) => ({ url, title }));
}
export function createAgentTools(config: AgentToolConfiguration = {}): AgentToolDefinition[] {
  const tools: AgentToolDefinition[] = [
    { id: "web-search", description: "Search the web through Exa's x402 endpoint. Returns ranked sources for a specific investigation question.", inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 1000 }, numResults: { type: "integer", minimum: 1, maximum: 5 } }, required: ["query"], additionalProperties: false },
      request(input) { exactFields(input, ["query", "numResults"]); const query = boundedString(input.query, "Search query", 1000); const count = input.numResults ?? 3; if (!Number.isInteger(count) || Number(count) < 1 || Number(count) > 5) throw new Error("Choose 1–5 search results"); return { url: "https://api.exa.ai/search", method: "POST", body: JSON.stringify({ query, numResults: count, type: "auto" }) }; }, sources: observedSources },
    { id: "crypto-news", description: "Retrieve the current crypto-news snapshot through Otto's x402 endpoint. Check source timestamps before treating it as recent.", inputSchema: { type: "object", properties: {}, additionalProperties: false },
      request(input) { exactFields(input, []); return { url: "https://x402.ottoai.services/crypto-news", method: "GET" }; }, sources: observedSources },
    { id: "crypto-prices", description: "Retrieve spot prices for up to five ticker symbols through APIToll's x402 endpoint. Prices alone do not explain protocol activity.", inputSchema: { type: "object", properties: { coins: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 } }, required: ["coins"], additionalProperties: false },
      request(input) { exactFields(input, ["coins"]); if (!Array.isArray(input.coins) || input.coins.length < 1 || input.coins.length > 5 || input.coins.some(c => typeof c !== "string" || !/^[A-Z0-9]{2,12}$/.test(c))) throw new Error("Provide 1–5 ticker symbols such as BTC or ETH"); const url = new URL("https://crypto.apitoll.cloud/v1/crypto/price"); url.searchParams.set("coins", input.coins.join(",")); return { url: url.toString(), method: "GET" }; }, sources: observedSources },
  ];
  if (config.agent0) {
    const { endpoint, source } = config.agent0; const url = graphEndpoint(endpoint);
    if (!url.endsWith(`/subgraphs/id/${source.deployment}`)) throw new Error("Agent0 endpoint differs from the reviewed deployment");
    tools.push({ id: "graph-agent0", description: `Read agent registrations and feedback from the reviewed ${source.chain} Agent0 deployment. Feedback coverage is not proof of service quality.`, inputSchema: { type: "object", properties: { maxResults: { type: "integer", minimum: 2, maximum: 10 } }, additionalProperties: false },
      request(input) { exactFields(input, ["maxResults"]); const maxResults = input.maxResults ?? 5; if (!Number.isInteger(maxResults) || Number(maxResults) < 2 || Number(maxResults) > 10) throw new Error("Choose 2–10 candidates"); const query = compileResearchQuery({ version: 1, template: "agent0-due-diligence", source, maxResults: Number(maxResults) }); return { url, method: "POST", body: JSON.stringify({ query }) }; }, sources: () => [{ url, title: `Agent0 · ${source.chain} · ${source.deployment}` }] });
  }
  if (config.protocols?.length) {
    const sources = structuredClone(config.protocols);
    for (const source of sources) {
      source.endpoint = graphEndpoint(source.endpoint);
      if (!source.id || !source.queries.length) throw new Error("A protocol needs a source ID and verified queries");
      for (const query of source.queries) validateConfiguredQuery(query.query);
    }
    tools.push({ id: "graph-protocol", description: `Query verified protocol datasets: ${sources.map(s => `${s.id} (${s.label}): ${s.queries.map(q => `${q.id} — ${q.description}`).join("; ")}`).join("\n")}`, inputSchema: { type: "object", properties: { sourceId: { type: "string", enum: sources.map(s => s.id) }, queryId: { type: "string" } }, required: ["sourceId", "queryId"], additionalProperties: false },
      request(input) { exactFields(input, ["sourceId", "queryId"]); const source = sources.find(s => s.id === input.sourceId), query = source?.queries.find(q => q.id === input.queryId); if (!source || !query) throw new Error("Choose a reviewed source and query from the tool description"); return { url: source.endpoint, method: "POST", body: JSON.stringify({ query: query.query }) }; }, sources: observedSources });
  }
  if (config.testnetEndpoints) {
    for (const tool of tools) {
      const endpoint = config.testnetEndpoints[tool.id];
      if (!endpoint) continue;
      const url = new URL(endpoint);
      if (!(url.protocol === "https:" || url.protocol === "http:" && url.hostname === "127.0.0.1") || url.username || url.password || url.search || url.hash) throw new Error("Invalid first-party testnet endpoint");
      const validate = tool.request;
      tool.request = input => { validate(input); return { url: url.toString(), method: "POST", body: JSON.stringify(input) }; };
      tool.description = `Mandate-hosted testnet x402 service. ${tool.description.replace(/through Exa's x402 endpoint|through Otto's x402 endpoint|through APIToll's x402 endpoint/g, "through the configured live data provider")}`;
    }
    // Testnet profiles never accidentally fall through to a mainnet vendor.
    return tools.filter(t => Boolean(config.testnetEndpoints?.[t.id]));
  }
  return tools;
}
export function toolById(tools: AgentToolDefinition[], id: AgentToolId): AgentToolDefinition {
  const found = tools.find(t => t.id === id); if (!found) throw new Error("Tool is not configured"); return found;
}
