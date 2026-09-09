#!/usr/bin/env node
/**
 * Refund a mandate's unspent deposit (cooperative, no device tap — the hot
 * session key signs the zero-charge voucher). Reopens the mandate from
 * mandate.yaml purely to resolve the channel; the device must be attached
 * for address resolution but is never prompted.
 *
 * The facilitator + paid service must be running (npm run facilitator, then
 * the service with --receiver) — the refund probes the service URL.
 */

import { readFile } from "node:fs/promises";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const FILE = process.env.MANDATE_FILE ?? `${ROOT}/mandate.yaml`;

await ensureWalletPass();
if (!process.env.WALLET_PASS) {
  console.error("WALLET_PASS missing — run npm run device first");
  process.exit(1);
}
if (!process.env.MANDATE_EVM_RPC_URL) {
  console.error("Missing MANDATE_EVM_RPC_URL");
  process.exit(1);
}

const { parseMandateFile } = await import(`${ROOT}/packages/gateway/src/mandate-config.ts`);
const text = await readFile(FILE, "utf8").catch(() => {
  console.error(`${FILE} missing.`);
  process.exit(1);
});
const mf = parseMandateFile(text);
const sealedSessionKey = await readFile(`${ROOT}/secrets/mandate-session.enc`);

const { openMandate } = await import(`${ROOT}/packages/gateway/src/mandate.ts`);
const mandate = await openMandate({
  rpcUrl: mf.rpcUrl,
  storageRoot: mf.storageRoot.startsWith("/") ? mf.storageRoot : `${ROOT}/${mf.storageRoot}`,
  sessionKeyName: mf.sessionKey,
  sealedSessionKey,
  ceilingBaseUnits: mf.ceilingBaseUnits,
  salt: mf.salt,
  derivationPath: mf.derivationPath,
  deviceTimeoutMs: 30_000,
});
try {
  const res = await mandate.refund(mf.serviceUrl);
  console.log(JSON.stringify(res, null, 2));
  console.log(`\nREFUND_OK taps=${mandate.taps}`);
  if (mandate.taps !== 0) {
    console.error("WARNING: refund consumed a device tap — investigate before trusting this path.");
    process.exit(1);
  }
} finally {
  mandate.close();
}
