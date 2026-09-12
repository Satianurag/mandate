/** First-party x402 tools on loopback. Graph and spending keys stay inside the broker. */
import type { Server } from "node:http";
import { createAgentToolService } from "./agent-tool-service.ts";
import { createLiveAgentProviders } from "./agent-live-providers.ts";
import { withSealedGraphKey } from "./analytics.ts";
import type { AgentToolConfiguration } from "./agent-tools.ts";
import type { Journal } from "./journal.ts";

export const LOCAL_TOOL_HOST = "127.0.0.1";
export const LOCAL_TOOL_PORT = 8425;
export const LOCAL_TOOL_ORIGIN = `http://${LOCAL_TOOL_HOST}:${LOCAL_TOOL_PORT}`;

export function localToolUrl(id: string): string {
  return `${LOCAL_TOOL_ORIGIN}/tools/${id}`;
}

export async function startLocalAgentTools(input: {
  payTo: string;
  facilitatorUrl: string;
  journal: Journal;
  tools: AgentToolConfiguration;
}): Promise<{ server: Server; origin: string }> {
  const providers = createLiveAgentProviders({
    tools: input.tools,
    withGraphCredential: fn => withSealedGraphKey(fn),
  });
  const catalog = [...providers.evm, ...providers.hedera.filter(p => !providers.evm.some(e => e.id === p.id))];
  if (!catalog.length) throw new Error("No first-party tools are configured");
  const server = await createAgentToolService({
    network: "eip155:8453",
    payTo: input.payTo,
    facilitatorUrl: input.facilitatorUrl,
    journal: input.journal,
    providers: catalog,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(LOCAL_TOOL_PORT, LOCAL_TOOL_HOST, () => resolve());
  });
  return { server, origin: LOCAL_TOOL_ORIGIN };
}
