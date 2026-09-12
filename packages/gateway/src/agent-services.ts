/** Load explicit production configuration without unlocking keys or spending at startup. */
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { VertexAgentModel, validateVertexConfig, type VertexAgentConfig } from "./agent-model.ts";
import { ExactAgentExecutor, chainSettlementVerifier, type ExactAgentAuthority } from "./agent-exact.ts";
import { createAgentTools, type AgentToolConfiguration } from "./agent-tools.ts";
import { withSecret } from "./keyring.ts";
import type { Journal } from "./journal.ts";
import type { AgentModel, AgentToolExecutor } from "./agent-runtime.ts";
export interface AgentServices {
  model: AgentModel; executor: AgentToolExecutor; authorityId: string;
  readiness?: () => { ready: boolean; reason: string };
}
export interface AgentRuntimeConfiguration {
  version: 1; vertex: VertexAgentConfig; authority: ExactAgentAuthority;
  tools: AgentToolConfiguration; rpcUrl: string;
  sealedKey: { file: string; ringKey: string };
}
export async function loadAgentServices(dataDir: string, journal: Journal): Promise<{ services: AgentServices | null; reason: string }> {
  const text = await readFile(join(dataDir, "agent-runtime.json"), "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null; throw e;
  });
  if (!text) return { services: null, reason: "Set up a model and a Ledger-approved allowance to run agents." };
  try {
    const config = JSON.parse(text) as AgentRuntimeConfiguration;
    if (config.version !== 1) throw new Error("Unsupported agent runtime configuration version");
    const model = new VertexAgentModel(validateVertexConfig({ ...config.vertex }));
    const rpc = new URL(config.rpcUrl);
    if (rpc.protocol !== "https:" || rpc.username || rpc.password || rpc.hash) throw new Error("Agent settlement RPC must use HTTPS without embedded credentials");
    if (!/^[a-zA-Z0-9_-]+\.enc$/.test(config.sealedKey?.file ?? "") || !/^[a-zA-Z0-9_-]{1,64}$/.test(config.sealedKey?.ringKey ?? "")) throw new Error("A local sealed spending key is required");
    const sealedFile = join(dataDir, config.sealedKey.file);
    await access(sealedFile);
    const address = getAddress(config.authority.spendingAddress);
    const executor = new ExactAgentExecutor({ authority: config.authority, journal, tools: createAgentTools(config.tools), verify: chainSettlementVerifier(config.rpcUrl, config.authority.network), signer: {
      address,
      async signTypedData(parameters) {
        const ciphertext = await readFile(sealedFile);
        return withSecret(config.sealedKey.ringKey, ciphertext, async key => {
          if (key.length !== 32) throw new Error("Spending key is not a 32-byte private key");
          const account = privateKeyToAccount(`0x${key.toString("hex")}` as Hex);
          if (account.address !== address) throw new Error("Sealed key differs from the reviewed spending address");
          return account.signTypedData(parameters);
        });
      },
    } });
    const readiness = () => {
      const a = journal.mandate(config.authority.id);
      if (Date.now() >= config.authority.expiresAt) return { ready: false, reason: "The spending allowance has expired." };
      if (a?.state !== "active") return { ready: false, reason: "The spending allowance is stopped or closed." };
      if (a.deposit !== "funded") return { ready: false, reason: "Confirm Ledger funding before starting an investigation." };
      if (journal.requests(a.id).some(r => ["signed", "uncertain", "reserved"].includes(r.state))) return { ready: false, reason: "A payment needs reconciliation before new spending." };
      const totals = journal.totals(a.id, config.authority.windowMs);
      if (BigInt(totals.spent) + BigInt(totals.reserved) >= BigInt(config.authority.ceilingBaseUnits)) return { ready: false, reason: "The shared spending allowance is exhausted." };
      return { ready: true, reason: "Ready to investigate within your Ledger-approved allowance." };
    };
    return { services: { model, executor, authorityId: config.authority.id, readiness }, reason: readiness().reason };
  } catch (e) { return { services: null, reason: `Agent setup needs attention: ${e instanceof Error ? e.message : "invalid configuration"}` }; }
}
