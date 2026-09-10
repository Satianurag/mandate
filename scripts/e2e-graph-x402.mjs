#!/usr/bin/env node
/**
 * Phase 2a E2E: Graph testnet x402 through Mandate policy hooks + HCS.
 * Stock ExactEvmScheme + Ledger — never X402_PRIVATE_KEY.
 * Unpaid 402 must be exact@eip155:84532 (never production 8453 / F31).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ensureWalletPass } from "./load-wallet-pass.mjs";
import { GRAPH_X402_TESTNET, GRAPH_X402_TESTNET_SUBGRAPH } from "../packages/gateway/src/graph.ts";
import { probeGraphX402Testnet, queryGraphX402Testnet } from "../packages/gateway/src/graph-x402.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const subgraph = process.env.MANDATE_GRAPH_X402_SUBGRAPH ?? GRAPH_X402_TESTNET_SUBGRAPH;
const query = "{ _meta { block { number } } }";

await ensureWalletPass();

const probe = await probeGraphX402Testnet(subgraph);
if (!probe.ok) {
  const line = JSON.stringify({ gateway: GRAPH_X402_TESTNET, subgraph, ...probe }, null, 2);
  console.error(line);
  await mkdir(`${ROOT}/.live-results`, { recursive: true });
  await writeFile(`${ROOT}/.live-results/e2e-graph-x402.txt`, line + "\n").catch(() => {});
  console.error("FINDING F8: Graph x402 testnet is not a live Sepolia rail. No stub, no mainnet fallback.");
  process.exit(2);
}

console.log("GRAPH_X402_TESTNET_OFFER", JSON.stringify(probe.challenge.accepts[0]));

let rpc = process.env.MANDATE_EVM_RPC_URL;
if (!rpc) {
  try {
    const { parseMandateFile } = await import(`${ROOT}/packages/gateway/src/mandate-config.ts`);
    rpc = parseMandateFile(await readFile(`${ROOT}/mandate.yaml`, "utf8")).rpcUrl;
  } catch {
    rpc = "https://sepolia.base.org";
  }
}

const accountId = process.env.MANDATE_HEDERA_ACCOUNT_ID;
const topicId = process.env.MANDATE_HCS_TOPIC_ID;
if (!accountId) {
  console.error("Missing MANDATE_HEDERA_ACCOUNT_ID (HCS audit + UAID)");
  process.exit(1);
}
if (!topicId) {
  console.error("Missing MANDATE_HCS_TOPIC_ID (this E2E must prove the HCS audit, not a bare Graph 200)");
  process.exit(1);
}

console.error(">>> Ledger: 1) step-up address-verify if policy escalates  2) EIP-3009 USDC");
const startedAt = new Date(Date.now() - 5_000).toISOString();
const { DmkEvmSigner } = await import(`${ROOT}/packages/gateway/src/dmksigner.ts`);
const { createMandateEvmClient } = await import(`${ROOT}/packages/gateway/src/client.ts`);
const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
let code = 1;
try {
  const hederaEnc = await readFile(`${ROOT}/secrets/hedera.enc`);
  const graphEnc = await readFile(`${ROOT}/secrets/graph.enc`);
  const graphApiKey = await withSecret("graph-gateway", graphEnc, (b) =>
    Promise.resolve(b.toString("utf8").trim())
  );
  const device = await DmkEvmSigner.create({
    timeoutMs: Number(process.env.MANDATE_STEPUP_TIMEOUT_MS ?? 120_000),
  });
  const { x402, getLastDecision } = createMandateEvmClient({
    evmSigner: device,
    rpcUrl: rpc,
    hederaCiphertext: hederaEnc,
    accountId,
    graphApiKey,
    hcsTopic: topicId,
  });
  const paid = await queryGraphX402Testnet(subgraph, query, {
    signer: device,
    rpcUrl: rpc,
    x402,
  });
  const meta = paid.data?._meta?.block?.number;
  if (meta == null) {
    console.error("GRAPH_X402_FAILED: paid body missing _meta.block.number");
  } else {
    const last = getLastDecision();
    const summary = {
      ok: true,
      gateway: paid.gateway,
      subgraph,
      network: paid.network,
      amount: probe.challenge.accepts[0]?.amount,
      asset: probe.challenge.accepts[0]?.asset,
      payer: device.address,
      taps: device.signCalls,
      tx: paid.settlementId ?? "",
      block: meta,
      verdict: last?.decision.verdict ?? null,
    };
    if (topicId) {
      const { pollTopicRecord } = await import(`${ROOT}/packages/gateway/src/evidence.ts`);
      const found = await pollTopicRecord(
        topicId,
        (r) => {
          if (r?.ts && r.ts < startedAt) return false;
          if (paid.settlementId && r?.txId === paid.settlementId) return true;
          return (
            typeof r?.origin === "string" &&
            r.origin.includes("thegraph.com") &&
            (r.verdict === "allow" || r.verdict === "step_up")
          );
        },
        { timeoutMs: 90_000 }
      );
      summary.hcsSeq = found.sequence;
      summary.hcsVerdict = found.record.verdict;
      summary.hcsTxId = found.record.txId ?? "";
      console.log(`HCS verified: seq=${found.sequence} verdict=${found.record.verdict}`);
    }
    console.log("GRAPH_X402_TESTNET_OK", JSON.stringify(summary));
    await mkdir(`${ROOT}/.live-results`, { recursive: true });
    await writeFile(`${ROOT}/.live-results/e2e-graph-x402.txt`, JSON.stringify(summary, null, 2) + "\n");
    code = 0;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
} finally {
  try {
    const { resetDmk } = await import(`${ROOT}/packages/gateway/src/dmk-session.ts`);
    resetDmk();
  } catch {
    /* device already released */
  }
  process.exit(code);
}
