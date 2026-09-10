/**
 * Stock Subgraph MCP client (The Graph hosted SSE server).
 *
 * Discovery of Agent0 deployments MUST go through MCP tools — not a second
 * GraphQL client that already knows the IDs. Tool names are listed live
 * (`tools/list`); we never assume a particular tool slug.
 *
 * Endpoint documented at:
 *   https://thegraph.com/docs/en/ai-suite/subgraph-mcp/cursor/
 *   https://subgraphs.mcp.thegraph.com/sse
 *
 * `@graphops/subgraph-mcp` is not on npm (F30). `@graphprotocol/mcp` is a
 * Pinax market client. This module speaks MCP to the hosted Graph server.
 */

export const SUBGRAPH_MCP_SSE = "https://subgraphs.mcp.thegraph.com/sse";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

export interface McpClient {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

type FetchFn = typeof fetch;

interface JsonRpc {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Open an MCP session over SSE. The connection stays up until `close()`.
 * Auth is the Studio gateway API key (Bearer), never an env private key.
 */
export async function openSubgraphMcp(
  apiKey: string,
  opts: { url?: string; fetchFn?: FetchFn } = {}
): Promise<McpClient> {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = new URL(opts.url ?? SUBGRAPH_MCP_SSE);
  const headers: Record<string, string> = {
    accept: "text/event-stream",
    authorization: `Bearer ${apiKey}`,
    "user-agent": "mandate/0.1",
  };

  const sse = await fetchFn(base.toString(), { headers });
  if (!sse.ok || !sse.body) {
    throw new Error(`Subgraph MCP SSE HTTP ${sse.status} at ${base}`);
  }

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let buf = "";
  let endpointPath: string | null = null;
  let endpointReady!: (p: string) => void;
  const endpointP = new Promise<string>((r) => {
    endpointReady = r;
  });
  let id = 0;
  let closed = false;

  const reader = sse.body.getReader();
  const dec = new TextDecoder();

  const pump = async () => {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      buf = consumeSse(buf, (event, data) => {
        if (event === "endpoint") {
          endpointPath = data.trim();
          endpointReady(endpointPath);
          return;
        }
        if (event === "message" || event === "") {
          let msg: JsonRpc;
          try {
            msg = JSON.parse(data) as JsonRpc;
          } catch {
            return;
          }
          if (typeof msg.id === "number" && pending.has(msg.id)) {
            const waiter = pending.get(msg.id)!;
            pending.delete(msg.id);
            if (msg.error) waiter.reject(new Error(`MCP: ${msg.error.message}`));
            else waiter.resolve(msg.result);
          }
        }
      });
    }
  };
  const pumping = pump().catch((e) => {
    if (!closed) {
      for (const w of pending.values()) w.reject(e instanceof Error ? e : new Error(String(e)));
      pending.clear();
    }
  });

  const post = async (method: string, params: unknown): Promise<unknown> => {
    const path = endpointPath ?? (await endpointP);
    const rpcId = ++id;
    const url = new URL(path, base);
    const result = new Promise((resolve, reject) => {
      pending.set(rpcId, { resolve, reject });
    });
    const res = await fetchFn(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "user-agent": "mandate/0.1",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
    });
    if (!res.ok) {
      pending.delete(rpcId);
      throw new Error(`MCP ${method} HTTP ${res.status}`);
    }
    return result;
  };

  await endpointP;
  await post("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mandate", version: "0.1.0" },
  });
  // notifications have no id; fire-and-forget
  const path = endpointPath ?? (await endpointP);
  await fetchFn(new URL(path, base).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "user-agent": "mandate/0.1",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  }).catch(() => {});

  return {
    async listTools() {
      const result = (await post("tools/list", {})) as { tools?: McpTool[] };
      return result.tools ?? [];
    },
    async callTool(name, args) {
      const result = (await post("tools/call", { name, arguments: args })) as {
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
      };
      if (result?.isError) {
        throw new Error(`MCP tool ${name} returned isError`);
      }
      const text = (result?.content ?? [])
        .map((c) => (typeof c.text === "string" ? c.text : ""))
        .join("\n")
        .trim();
      return text;
    },
    async close() {
      closed = true;
      await reader.cancel().catch(() => {});
      await pumping.catch(() => {});
    },
  };
}

function consumeSse(buf: string, onEvent: (event: string, data: string) => void): string {
  const parts = buf.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const block of parts) {
    let event = "";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length) onEvent(event, dataLines.join("\n"));
  }
  return rest;
}

/** Pick the first tool whose name matches any of the needles (case-insensitive).
 * Skip IPFS-hash tools — those are lookup-by-cid, not discovery (F30 live miss). */
export function pickTool(tools: McpTool[], ...needles: string[]): McpTool | undefined {
  const lower = needles.map((n) => n.toLowerCase());
  return tools.find((t) => {
    const name = t.name.toLowerCase();
    if (name.includes("ipfs")) return false;
    const required = t.inputSchema?.required ?? [];
    if (required.some((r) => r.toLowerCase().includes("ipfs"))) return false;
    return lower.some((n) => name.includes(n));
  });
}
