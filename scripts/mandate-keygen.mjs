#!/usr/bin/env node
/**
 * Provision one mandate's keys:
 * - resolves the payer address from the Ledger (read-only, no tap — but the
 *   device must be attached, unlocked, Ethereum app open), and
 * - generates the 32-byte voucher session key, sealing it into the Key Ring.
 *
 * The sealed file is forever bound to its channels: rotating the session key
 * orphans them, so this refuses to overwrite. To rotate, delete
 * secrets/mandate-session.enc by hand (and refund open mandates first).
 */

import { randomBytes } from "node:crypto";
import { writeFile, access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const ENC = `${ROOT}/secrets/mandate-session.enc`;

await ensureWalletPass();
if (!process.env.WALLET_PASS) {
  console.error("WALLET_PASS missing — run npm run device first");
  process.exit(1);
}

try {
  await access(ENC, constants.R_OK);
  console.error(
    "secrets/mandate-session.enc already exists — refusing to overwrite.\n" +
      "The session key is committed into open channels; to rotate, refund them\n" +
      "(npm run mandate:refund), delete the file by hand, and re-run."
  );
  process.exit(1);
} catch {
  /* absent — proceed */
}

const { DmkEvmSigner } = await import(`${ROOT}/packages/gateway/src/dmksigner.ts`);
let payer;
try {
  const signer = await DmkEvmSigner.create({ timeoutMs: 30_000 });
  payer = signer.address;
} catch (e) {
  console.error(`No payer address: ${e instanceof Error ? e.message : e}`);
  console.error("Attach + unlock the Ledger and open the Ethereum app, then re-run.");
  process.exit(1);
}

await mkdir(`${ROOT}/secrets`, {recursive:true,mode:0o700});
const { seal } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
const raw = randomBytes(32);
const sealed = await seal("mandate-session", raw);
const { privateKeyToAccount } = await import("viem/accounts");
const session = privateKeyToAccount(`0x${raw.toString("hex")}`).address;
raw.fill(0);
await writeFile(ENC, sealed, { mode: 0o600, flag: "wx" });

console.log(`payer (device):   ${payer}`);
console.log(`session (sealed): ${session}  — signs vouchers only, needs no funds`);
console.log(`sealed → secrets/mandate-session.enc`);
console.log(`\nFund the PAYER with Base Sepolia USDC: https://faucet.circle.com`);
console.log(`USDC only — deposits are gasless EIP-3009, the device needs no ETH.`);
console.log(`Then open the workspace, review authority, and explicitly request funding. The legacy file is not migrated. Original example: mandate.example.yaml → mandate.yaml, set the receiver, npm run mandate:open.`);
