#!/usr/bin/env node
/**
 * Open a mandate and stream inside it: one Ledger tap, then N voucher-paid
 * calls with no further device interaction.
 *
 * Spawns the self-hosted facilitator + paid service, opens the mandate from
 * mandate.yaml, pays 3 × /analytics, then asserts the demo's load-bearing
 * claim: exactly ONE device tap for the whole stream. Prints the channel id,
 * cumulative spend, and the persisted channel record.
 *
 * Requires: mandate.yaml, secrets/mandate-session.enc (+ facilitator keys),
 *   MANDATE_EVM_RPC_URL, WALLET_PASS, funded payer (USDC) + submitter (ETH).
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const FILE = process.env.MANDATE_FILE ?? `${ROOT}/mandate.yaml`;
const CALLS = Number(process.env.MANDATE_CALLS ?? 3);

async function waitForHttp(url, label, accept = (r) => r.ok) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (accept(res)) return;
    } catch {
      /* child still booting */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} not ready (${url})`);
}

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return v;
}

await ensureWalletPass();
if (!process.env.WALLET_PASS) {
  console.error("WALLET_PASS missing — run npm run device first");
  process.exit(1);
}
need("MANDATE_EVM_RPC_URL");

const { parseMandateFile } = await import(`${ROOT}/packages/gateway/src/mandate-config.ts`);
const text = await readFile(FILE, "utf8").catch(() => {
  console.error(`${FILE} missing — copy mandate.example.yaml → mandate.yaml and edit it.`);
  process.exit(1);
});
const mf = parseMandateFile(text);
if (/^0x0+$/.test(mf.salt)) {
  console.error("mandate.yaml salt is still zero — generate a fresh bytes32 per mandate.");
  process.exit(1);
}
if (/^0x0+$/.test(mf.receiver)) {
  console.error("mandate.yaml receiver is still zero — set an address you control (else funds burn).");
  process.exit(1);
}
if (mf.receiver.toLowerCase() === (process.env.MANDATE_PAYER ?? "").toLowerCase()) {
  console.error("receiver must differ from the payer — self-channels are rejected.");
  process.exit(1);
}
const sealedSessionKey = await readFile(`${ROOT}/secrets/mandate-session.enc`).catch(() => {
  console.error("secrets/mandate-session.enc missing — run npm run mandate:keygen.");
  process.exit(1);
});

// Stack: facilitator (:8406) + paid service (:8405), both strict-booting.
const children = [];
function start(name, pkg, env, args = []) {
  const c = spawn(
    process.execPath,
    ["--experimental-strip-types", `${ROOT}/packages/${pkg}/src/index.ts`, ...args],
    { env: { ...process.env, ...env }, stdio: "inherit" }
  );
  children.push(c);
  return c;
}
start("facilitator", "facilitator", { FACILITATOR_PORT: "8406" });
await waitForHttp("http://127.0.0.1:8406/supported", "facilitator");
start(
  "service",
  "mandate-service",
  {
    MANDATE_SERVICE_PORT: "8405",
    MANDATE_FACILITATOR_URL: "http://127.0.0.1:8406",
    MANDATE_SERVICE_STATE: `${ROOT}/state/mandate-service`,
  },
  ["--receiver", mf.receiver]
);
await waitForHttp(
  "http://127.0.0.1:8405/analytics",
  "mandate service",
  (r) => r.status === 402 || r.ok
);

const { openMandate } = await import(`${ROOT}/packages/gateway/src/mandate.ts`);
let mandate;
try {
  mandate = await openMandate({
    rpcUrl: mf.rpcUrl,
    storageRoot: mf.storageRoot.startsWith("/") ? mf.storageRoot : `${ROOT}/${mf.storageRoot}`,
    sessionKeyName: mf.sessionKey,
    sealedSessionKey,
    ceilingBaseUnits: mf.ceilingBaseUnits,
    salt: mf.salt,
    derivationPath: mf.derivationPath,
    deviceTimeoutMs: 120_000,
  });
  console.log(`payer:   ${mandate.payer}`);
  console.log(`session: ${mandate.session}`);
  if (mandate.payer.toLowerCase() === mf.receiver.toLowerCase()) {
    throw new Error("receiver equals the payer — self-channels are rejected; edit mandate.yaml.");
  }

  console.log(`\nTap the Ledger ONCE to authorize the $${Number(mf.ceilingBaseUnits) / 1e6} USDC mandate…`);
  for (let i = 1; i <= CALLS; i++) {
    const res = await mandate.fetch(`${mf.serviceUrl}?q=${encodeURIComponent(`{ call${i} { id } }`)}`);
    const body = await res.text();
    const payHdrs = [...res.headers.entries()].filter(([k]) => /payment/i.test(k));
    console.log(`call ${i}: HTTP ${res.status} ${body.slice(0, 160)}`);
    if (payHdrs.length) console.log(`call ${i} payment headers: ${JSON.stringify(payHdrs).slice(0, 400)}`);
    if (res.status !== 200) throw new Error(`call ${i} failed: ${body.slice(0, 300)}`);
  }

  // The demo's load-bearing claim.
  if (mandate.taps !== 1) {
    throw new Error(`expected exactly 1 device tap, observed ${mandate.taps}`);
  }
  console.log(`\ntaps: ${mandate.taps} for ${CALLS} paid calls — vouchers covered the rest.`);

  // The persisted channel record: cumulative spend, on disk, restart-proof.
  const { decodePaymentRequiredHeader } = await import("@x402/core/http");
  const probe = await fetch(mf.serviceUrl);
  const header = probe.headers.get("payment-required");
  if (!header) throw new Error("service stopped offering payment — cannot resolve channel");
  const offer = decodePaymentRequiredHeader(header);
  const channelId = mandate.channelIdFor(offer.accepts[0]);
  const recordPath = `${mf.storageRoot.startsWith("/") ? mf.storageRoot : `${ROOT}/${mf.storageRoot}`}/client/${channelId.toLowerCase()}.json`;
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  console.log(`channel: ${channelId}`);
  console.log(`cumulative: ${record.chargedCumulativeAmount} base units across ${CALLS} calls`);

  // HCS evidence: the mandate's financial truth lives on Base Sepolia, but
  // the cross-rail audit trail lives here. Skipped loudly — never silently —
  // when the Hedera leg is not configured.
  if (process.env.MANDATE_HCS_TOPIC_ID && process.env.MANDATE_HEDERA_ACCOUNT_ID) {
    const hederaEnc = await readFile(`${ROOT}/secrets/hedera.enc`).catch(() => null);
    if (!hederaEnc) {
      console.log("HCS skipped loudly: secrets/hedera.enc missing — mandate itself is complete.");
    } else {
      const { buildMandateRecord, submit } = await import(`${ROOT}/packages/gateway/src/audit.ts`);
      const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
      const rec = buildMandateRecord({
        channelId,
        salt: mf.salt,
        payer: mandate.payer,
        receiver: mf.receiver,
        ceilingBaseUnits: mf.ceilingBaseUnits,
        cumulativeBaseUnits: String(record.chargedCumulativeAmount ?? "0"),
        calls: CALLS,
        taps: mandate.taps,
        serviceUrl: mf.serviceUrl,
      });
      await withSecret("hedera-payment", hederaEnc, (key) =>
        submit(process.env.MANDATE_HCS_TOPIC_ID, rec, {
          accountId: process.env.MANDATE_HEDERA_ACCOUNT_ID,
          privateKeyHex: key.toString("utf8").trim(),
        })
      );
      console.log(`HCS audited on topic ${process.env.MANDATE_HCS_TOPIC_ID}`);
    }
  } else {
    console.log("HCS skipped loudly: MANDATE_HCS_TOPIC_ID/MANDATE_HEDERA_ACCOUNT_ID unset.");
  }
  console.log(`\nMANDATE_OK channel=${channelId} taps=1 cumulative=${record.chargedCumulativeAmount}`);
} finally {
  mandate?.close();
  for (const c of children) c.kill();
}
