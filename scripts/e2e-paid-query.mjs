#!/usr/bin/env node
/**
 * Phase 1 E2E gate: unpaid 402 from both services; paid body is live Agent0
 * JSON (not agent-demo-1). Payment itself is `npm run e2e:payment` /
 * `mandate:open`; this script proves the 402 shape and the Agent0 payload.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { ensureWalletPass } from "./load-wallet-pass.mjs";
import { findServicePayTo } from "./resolve-pay-to.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const FAC_PORT = Number(process.env.FACILITATOR_PORT ?? 8406);
const MS_PORT = Number(process.env.MANDATE_SERVICE_PORT ?? 8405);
const SVC_PORT = Number(process.env.SERVICE_PORT ?? 8403);

await ensureWalletPass();

try {
  const { parseMandateFile } = await import(`${ROOT}/packages/gateway/src/mandate-config.ts`);
  const yaml = await readFile(`${ROOT}/mandate.yaml`, "utf8");
  const m = parseMandateFile(yaml);
  process.env.MANDATE_EVM_RPC_URL ??= m.rpcUrl;
  process.env.MANDATE_SERVICE_RECEIVER ??= m.receiver;
} catch {
  // mandate.yaml is operator-local; unpaid Hedera 402 still runs without it.
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHttp(url, timeoutMs = 45_000) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      last = String(res.status);
      if (res.status !== 0) return res;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await wait(400);
  }
  throw new Error(`timeout waiting for ${url} (${last})`);
}

async function unpaid(url, expectScheme) {
  const res = await fetch(url);
  if (res.status !== 402) throw new Error(`${url} expected 402, got ${res.status}`);
  const header = res.headers.get("payment-required");
  if (!header) throw new Error(`${url} 402 missing PAYMENT-REQUIRED`);
  const body = decodePaymentRequiredHeader(header);
  const scheme = body.accepts[0]?.scheme;
  if (scheme !== expectScheme) throw new Error(`${url} scheme ${scheme} != ${expectScheme}`);
  console.log(`UNPAID_OK ${url} ${scheme}`);
}

const kids = [];
function spawnNode(file, env) {
  const child = spawn(process.execPath, ["--experimental-strip-types", file], {
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  kids.push(child);
  return child;
}

try {
  const dir = await mkdtemp(join(tmpdir(), "mandate-e2e-"));
  if (process.env.MANDATE_EVM_RPC_URL && process.env.MANDATE_SERVICE_RECEIVER) {
    spawnNode(`${ROOT}/packages/facilitator/src/index.ts`, { FACILITATOR_PORT: String(FAC_PORT) });
    await waitHttp(`http://127.0.0.1:${FAC_PORT}/supported`);
    spawnNode(`${ROOT}/packages/mandate-service/src/index.ts`, {
      MANDATE_SERVICE_PORT: String(MS_PORT),
      MANDATE_FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
      MANDATE_SERVICE_STATE: dir,
    });
    await waitHttp(`http://127.0.0.1:${MS_PORT}/analytics`);
    await unpaid(`http://127.0.0.1:${MS_PORT}/analytics`, "batch-settlement");
    await unpaid(`http://127.0.0.1:${MS_PORT}/usage`, "upto");
  } else {
    console.log("SKIP mandate-service 402 (set MANDATE_EVM_RPC_URL + MANDATE_SERVICE_RECEIVER)");
  }

  const payer = process.env.MANDATE_HEDERA_ACCOUNT_ID;
  const merchant =
    (payer ? await findServicePayTo(payer) : null) ?? process.env.SERVICE_PAY_TO ?? payer;
  if (merchant) {
    spawnNode(`${ROOT}/packages/service/src/index.ts`, {
      SERVICE_PORT: String(SVC_PORT),
      SERVICE_PAY_TO: merchant,
      // Operator env may point MANDATE_FACILITATOR_URL at the local EVM facilitator.
      MANDATE_FACILITATOR_URL: "https://api.testnet.blocky402.com",
    });
    await waitHttp(`http://127.0.0.1:${SVC_PORT}/analytics?q=${encodeURIComponent("{ agents { id } }")}`);
    await unpaid(`http://127.0.0.1:${SVC_PORT}/analytics?q=${encodeURIComponent("{ agents { id } }")}`, "exact");
    await unpaid(`http://127.0.0.1:${SVC_PORT}/usdc-analytics?q=${encodeURIComponent("{ agents { id } }")}`, "exact");
  } else {
    console.log("SKIP hedera service 402 (set SERVICE_PAY_TO)");
  }

  const { liveAnalyticsBody } = await import(`${ROOT}/packages/gateway/src/analytics.ts`);
  const body = await liveAnalyticsBody("{ agents { id } }", { scheme: "e2e-paid-query-body" });
  const text = JSON.stringify(body);
  if (text.includes("agent-demo-1")) {
    throw new Error("live Agent0 body leaked agent-demo-1");
  }
  if (!body.source?.subgraphId) {
    throw new Error("live Agent0 body missing source.subgraphId");
  }
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    throw new Error("live Agent0 body has no rows");
  }
  console.log(
    "AGENT0_BODY_OK",
    body.source.chain,
    body.source.subgraphId,
    "rows",
    body.rows.length,
    "first",
    body.rows[0]?.id
  );
  console.log("E2E_UNPAID_OK");
  await mkdir(`${ROOT}/.live-results`, { recursive: true });
  await writeFile(
    `${ROOT}/.live-results/e2e-paid-query.txt`,
    `E2E_UNPAID_OK subgraph=${body.source.subgraphId} rows=${body.rows.length}\n`
  );
} finally {
  for (const k of kids) k.kill("SIGTERM");
}
