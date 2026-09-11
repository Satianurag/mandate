#!/usr/bin/env node
/**
 * Provision the self-hosted facilitator's two keys (both sealed):
 * - mandate-facilitator: submits settlement transactions (needs Base Sepolia
 *   ETH for gas).
 * - mandate-authorizer: the receiverAuthorizer — signs claim/refund EIP-712
 *   authorizations (no gas, never submits).
 *
 * Split so a compromised submitter cannot forge authorizations and a
 * compromised authorizer cannot submit anything. Refuses to overwrite.
 */

import { randomBytes } from "node:crypto";
import { writeFile, access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

await ensureWalletPass();
if (!process.env.WALLET_PASS) {
  console.error("WALLET_PASS missing — run npm run device first");
  process.exit(1);
}

await mkdir(`${ROOT}/secrets`, {recursive:true,mode:0o700});
const { seal } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
const { privateKeyToAccount } = await import("viem/accounts");

for (const name of ["mandate-facilitator", "mandate-authorizer"]) {
  const path = `${ROOT}/secrets/${name}.enc`;
  try {
    await access(path, constants.R_OK);
    console.error(`${path} already exists — refusing to overwrite (delete by hand to rotate).`);
    process.exit(1);
  } catch {
    /* absent — proceed */
  }
  const raw = randomBytes(32);
  const sealed = await seal(name, raw);
  const address = privateKeyToAccount(`0x${raw.toString("hex")}`).address;
  raw.fill(0);
  await writeFile(path, sealed, { mode: 0o600, flag: "wx" });
  console.log(`${name}: ${address}  → secrets/${name}.enc`);
}

console.log(`\nFund the SUBMITTER (mandate-facilitator) with Base Sepolia ETH for gas:`);
console.log(`https://www.alchemy.com/faucets/base-sepolia`);
console.log(`The authorizer signs EIP-712 only and needs no funds.`);
