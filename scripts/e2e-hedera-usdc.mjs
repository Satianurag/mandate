#!/usr/bin/env node
/**
 * Live end-to-end: stock ExactHederaScheme with Circle HTS USDC
 * (`exact@hedera:testnet`, asset 0.0.429274). Not EVM batch-settlement@296.
 *
 * Requires the same env as `npm run e2e:payment`.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { ensureWalletPass } from "./load-wallet-pass.mjs";
import { resolveServicePayTo } from "./resolve-pay-to.mjs";
import { BLOCKY402_URL } from "../packages/gateway/src/facilitators.ts";

const SERVICE_PORT = Number(process.env.SERVICE_PORT ?? 8403);
const ROOT = new URL("..", import.meta.url).pathname;

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return v;
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
      if (res.status !== 0) return res;
      last = String(res.status);
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await wait(400);
  }
  throw new Error(`timeout waiting for ${url} (${last})`);
}

await ensureWalletPass();
const payer = need("MANDATE_HEDERA_ACCOUNT_ID");
const payTo = await resolveServicePayTo(payer);
const topicId = need("MANDATE_HCS_TOPIC_ID");
if (!process.env.WALLET_PASS) {
  console.error("WALLET_PASS missing — run npm run device first");
  process.exit(1);
}

const svc = spawn(
  process.execPath,
  ["--experimental-strip-types", `${ROOT}/packages/service/src/index.ts`],
  {
    env: {
      ...process.env,
      SERVICE_PAY_TO: payTo,
      // Operator env may point MANDATE_FACILITATOR_URL at the local EVM facilitator.
      MANDATE_FACILITATOR_URL: BLOCKY402_URL,
    },
    stdio: "inherit",
  }
);
await waitHttp(
  `http://127.0.0.1:${SERVICE_PORT}/usdc-analytics?q=${encodeURIComponent("{ agents { id } }")}`
);

await (async () => {
let code = 0;
try {
  const { proxyFetch } = await import(`${ROOT}/packages/gateway/src/index.ts`);
  const { pollTopicRecord } = await import(`${ROOT}/packages/gateway/src/evidence.ts`);

  const url = `http://127.0.0.1:${SERVICE_PORT}/usdc-analytics?q=${encodeURIComponent("{ agents { id } }")}`;
  console.log(`e2e hedera USDC exact → ${url} payTo=${payTo}`);
  console.log("(tap the Ledger if policy escalates to step_up)");

  const res = await proxyFetch(url);
  const body = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(body.slice(0, 600));

  if (res.status !== 200) {
    console.error("E2E_FAILED: USDC exact payment did not settle");
    code = 1;
    return;
  }
  const parsed = JSON.parse(body);
  const txId = parsed.paid?.txId;
  if (!txId) {
    console.error("E2E_FAILED: no settlement txId in response");
    code = 1;
    return;
  }
  if (parsed.paid?.asset && parsed.paid.asset !== "0.0.429274") {
    console.error(`E2E_FAILED: expected Circle USDC asset, got ${parsed.paid.asset}`);
    code = 1;
    return;
  }
  console.log(`settled: ${txId}`);

  const found = await pollTopicRecord(topicId, (r) => r?.txId === txId, { timeoutMs: 90_000 });
  console.log(
    `HCS verified: seq=${found.sequence} consensus=${found.consensusTimestamp} verdict=${found.record.verdict}`
  );
  const line = `HEDERA_USDC_EXACT_OK txId=${txId} hcsSeq=${found.sequence} asset=0.0.429274`;
  console.log(line);
  await mkdir(`${ROOT}/.live-results`, { recursive: true });
  await writeFile(`${ROOT}/.live-results/e2e-hedera-usdc.txt`, line + "\n");
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  code = 1;
} finally {
  svc.kill("SIGTERM");
  try {
    const { resetDmk } = await import(`${ROOT}/packages/gateway/src/dmk-session.ts`);
    resetDmk();
  } catch {
    /* device already released */
  }
  process.exit(code);
}
})();
