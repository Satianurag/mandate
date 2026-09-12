/** Load explicit production configuration without unlocking keys or spending at startup. */
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { VertexAgentModel, validateVertexConfig, type VertexAgentConfig } from "./agent-model.ts";
import { ExactAgentExecutor, chainSettlementVerifier, evmAgentReceiptLocator, type ExactAgentAuthority } from "./agent-exact.ts";
import { createAgentTools, type AgentToolConfiguration } from "./agent-tools.ts";
import { withSecret } from "./keyring.ts";
import { digest, type Journal } from "./journal.ts";
import { AgentFundingController } from "./agent-funding.ts";
import { AgentReturnController } from "./agent-return.ts";
import type { ClientEvmSigner } from "@x402/evm";
import { hederaSettlementVerifier } from "./agent-hedera.ts";
import { createSealedHederaSigner } from "./hedera.ts";
import type { AgentModel, AgentToolExecutor } from "./agent-runtime.ts";
export interface AgentServices {
  model: AgentModel; executor: AgentToolExecutor; authorityId: string;
  readiness?: () => { ready: boolean; reason: string };
  funding?: AgentFundingController;
  returns?: AgentReturnController;
  inspect?: () => Record<string, unknown>;
  reconcilePayment?: (requestId: string, transactionHint?: string) => ReturnType<ExactAgentExecutor["reconcile"]>;
}
export interface AgentRuntimeConfiguration {
  version: 1; vertex: VertexAgentConfig; authority: ExactAgentAuthority;
  tools: AgentToolConfiguration; rpcUrl: string;
  sealedKey: { file: string; ringKey: string };
  sealedHederaKey?: { file: string };
  funding?: { facilitatorUrl: string };
}
export async function loadAgentServices(dataDir: string, journal: Journal): Promise<{ services: AgentServices | null; reason: string }> {
  const text = await readFile(join(dataDir, "agent-runtime.json"), "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null; throw e;
  });
  if (!text) return { services: null, reason: "Set up a model and a Ledger-approved allowance to run agents." };
  try {
    const config = JSON.parse(text) as AgentRuntimeConfiguration;
    if (config.version !== 1) throw new Error("Unsupported agent runtime configuration version");
    if (config.authority.network !== "eip155:84532") throw new Error("The deployed agent workspace is testnet-only");
    if (config.authority.toolConfigurationHash && config.authority.toolConfigurationHash !== digest(config.tools)) throw new Error("Agent tool definitions changed after the authority was reviewed");
    const model = new VertexAgentModel(validateVertexConfig({ ...config.vertex }));
    const rpc = new URL(config.rpcUrl);
    if (rpc.protocol !== "https:" || rpc.username || rpc.password || rpc.hash) throw new Error("Agent settlement RPC must use HTTPS without embedded credentials");
    if (!/^[a-zA-Z0-9_-]+\.enc$/.test(config.sealedKey?.file ?? "") || !/^[a-zA-Z0-9_-]{1,64}$/.test(config.sealedKey?.ringKey ?? "")) throw new Error("A local sealed spending key is required");
    const sealedFile = join(dataDir, config.sealedKey.file);
    await access(sealedFile);
    const ensureKeyRing = async () => {
      const loader = await import(new URL("../../../scripts/load-wallet-pass.mjs", import.meta.url).href) as { ensureWalletPass: () => Promise<string> };
      if (!await loader.ensureWalletPass()) throw new Error("Unlock the provisioned Ledger Key Ring through the OS keychain; never paste a password into the app");
    };
    let hedera;
    if (config.authority.hedera) {
      if (!/^[A-Za-z0-9_-]+\.enc$/.test(config.sealedHederaKey?.file ?? "")) throw new Error("A local sealed Hedera key is required");
      const ciphertext = await readFile(join(dataDir, config.sealedHederaKey!.file));
      const delegate = createSealedHederaSigner(ciphertext, config.authority.hedera.accountId);
      hedera = { signer: { accountId: delegate.accountId, createPartiallySignedTransferTransaction: async (requirements: import("@x402/core/types").PaymentRequirements) => { await ensureKeyRing(); return delegate.createPartiallySignedTransferTransaction(requirements); } }, verify: hederaSettlementVerifier() };
    }
    const address = getAddress(config.authority.spendingAddress);
    const spendingSigner: ClientEvmSigner = {
      address,
      async signTypedData(parameters) {
        await ensureKeyRing();
        const ciphertext = await readFile(sealedFile);
        return withSecret(config.sealedKey.ringKey, ciphertext, async key => {
          if (key.length !== 32) throw new Error("Spending key is not a 32-byte private key");
          const account = privateKeyToAccount(`0x${key.toString("hex")}` as Hex);
          if (account.address !== address) throw new Error("Sealed key differs from the reviewed spending address");
          return account.signTypedData(parameters);
        });
      },
    };
    const executor = new ExactAgentExecutor({ authority: config.authority, journal, tools: createAgentTools(config.tools), hedera,
      receiptLookupUrls: Object.values(config.tools.testnetEndpoints ?? {}), receiptLocator: evmAgentReceiptLocator(config.rpcUrl, config.authority.network),
      verify: chainSettlementVerifier(config.rpcUrl, config.authority.network), signer: spendingSigner });
    const funding = config.funding ? new AgentFundingController({ authority: config.authority, journal, rpcUrl: config.rpcUrl, facilitatorUrl: config.funding.facilitatorUrl,
      signer: async () => { await ensureKeyRing(); const { DmkEvmSigner } = await import("./dmksigner.ts"); return DmkEvmSigner.create({ timeoutMs: 120000 }); } }) : undefined;
    const returns = config.funding ? new AgentReturnController({ authority: config.authority, journal, rpcUrl: config.rpcUrl, facilitatorUrl: config.funding.facilitatorUrl, signer: spendingSigner }) : undefined;
    const inspect = () => ({ ...(funding?.review() ?? { authority: config.authority }), vertex: config.vertex, returnSupported: Boolean(returns), returnStatus: returns?.status(),
      researchSources: (config.tools.protocols ?? []).map(s => ({ id: s.id, label: s.label })), agentRegistry: config.tools.agent0?.source ?? null,
      configuredTools: createAgentTools(config.tools).map(t => ({ id: t.id, description: t.description })),
      payments: journal.requests(config.authority.id).map(r => { const receipt = r.receipt ? JSON.parse(r.receipt) as { transaction?: string } : null; return { id: r.id, state: r.state, network: r.network, asset: r.asset, amountBaseUnits: r.charged ?? r.maximum, transaction: receipt?.transaction ?? null, chainVerified: (receipt as { chainVerified?: boolean } | null)?.chainVerified === true, error: r.error, createdAt: r.created_at }; }) });
    const readiness = () => {
      const a = journal.mandate(config.authority.id);
      if (Date.now() >= config.authority.expiresAt) return { ready: false, reason: "The spending allowance has expired." };
      if (a?.state !== "active") return { ready: false, reason: "The spending allowance is stopped or closed." };
      if (a.deposit !== "funded") return { ready: false, reason: "Confirm Ledger funding before starting an investigation." };
      if (journal.requests(a.id).some(r => ["signed", "uncertain", "reserved"].includes(r.state))) return { ready: false, reason: "A payment is pending; new work waits until its outcome is known." };
      const totals = journal.totals(a.id, config.authority.windowMs);
      const effectiveCeiling = journal.effectiveAgentCeiling(a.id, config.authority.ceilingBaseUnits);
      if (BigInt(totals.spent) + BigInt(totals.reserved) >= BigInt(effectiveCeiling)) return { ready: false, reason: "The shared spending allowance is exhausted. Increase it with an explicit Ledger approval or return unused funds." };
      if (BigInt(totals.window) >= BigInt(config.authority.windowBaseUnits)) return { ready: false, reason: "The rolling spending limit is reached. Wait for the reviewed window to clear." };
      return { ready: true, reason: "Ready: testnet x402 services, live data, and a Ledger-funded bounded allowance." };
    };
    return { services: { model, executor, authorityId: config.authority.id, readiness, funding, returns, inspect, reconcilePayment: (id, hint) => executor.reconcile(id, hint) }, reason: readiness().reason };
  } catch (e) { return { services: null, reason: `Agent setup needs attention: ${e instanceof Error ? e.message : "invalid configuration"}` }; }
}
