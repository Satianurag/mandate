#!/usr/bin/env node
/**
 * Generate a Hedera testnet payer (ECDSA), fund it, complete the hollow account,
 * seal the key into the Key Ring, and print MANDATE_HEDERA_ACCOUNT_ID.
 *
 * Funding paths (first match wins):
 *   1. HEDERA_PAT — Portal Faucet API (https://docs.hedera.com/learn/getting-started/faucet-api)
 *   2. --wait — poll mirror after you fund via https://portal.hedera.com/faucet
 *
 * Usage:
 *   npm run setup:hedera              # generate + print faucet URL
 *   npm run setup:hedera -- --wait    # block until mirror sees the account
 *   HEDERA_PAT=… npm run setup:hedera
 */

import { spawn } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ensureWalletPass } from "./load-wallet-pass.mjs";
import {
  Client,
  PrivateKey,
  AccountId,
  Hbar,
  TransferTransaction,
  TransactionId,
} from "@hiero-ledger/sdk";

const ROOT = new URL("..", import.meta.url).pathname;
const WAIT = process.argv.includes("--wait");
const PAT = process.env.HEDERA_PAT?.trim();
const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1/accounts";
const PENDING = join(ROOT, "secrets/.hedera-pending.json");

function run(cmd, args, input, binaryStdout = false) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const outChunks = [];
    let stderr = "";
    c.stdout.on("data", (d) => outChunks.push(d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => {
      const stdout = binaryStdout
        ? Buffer.concat(outChunks)
        : Buffer.concat(outChunks).toString("utf8");
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
    });
    if (input) {
      c.stdin.write(input);
      c.stdin.end();
    } else {
      c.stdin.end();
    }
  });
}

async function mirrorAccount(evmAddress) {
  const res = await fetch(`${MIRROR}/${evmAddress}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`mirror ${res.status}`);
  const body = await res.json();
  // EVM alias lookup returns { account: "0.0.x", balance: {...}, ... } at top level.
  if (typeof body.account === "string") {
    return { account: body.account, balance: body.balance };
  }
  return body.accounts?.[0] ?? null;
}

async function pollMirror(evmAddress, label) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const acct = await mirrorAccount(evmAddress);
    if (acct?.account) {
      console.log(`${label} accountId=${acct.account} balance=${acct.balance?.balance ?? "?"}`);
      return acct.account;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error("timed out waiting for mirror node (fund the EVM address first)");
}

async function fundViaPat(evmAddress) {
  const res = await fetch("https://portal.hedera.com/api/disbursement/cli", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PAT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address: evmAddress, amount: 25, network: "testnet" }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`faucet API ${res.status}: ${text.slice(0, 300)}`);
  console.log(`faucet OK: ${text.trim()}`);
}

async function completeHollow(accountId, privateKey) {
  const client = Client.forTestnet();
  const id = AccountId.fromString(accountId);
  const tx = await new TransferTransaction()
    .addHbarTransfer(id, new Hbar(-1))
    .addHbarTransfer(AccountId.fromString("0.0.7162784"), new Hbar(1))
    .setTransactionId(TransactionId.generate(id))
    .freezeWith(client);
  const signed = await tx.sign(privateKey);
  const response = await signed.execute(client);
  await response.getReceipt(client);
  client.close();
  console.log("hollow account completed (fee-payer self-sign)");
}

async function sealKey(hexKey) {
  const encPath = join(ROOT, "secrets/hedera.enc");
  const { stdout } = await run(
    "wallet-cli",
    ["ring", "encrypt", "--key", "hedera-payment"],
    hexKey,
    true
  );
  if (!stdout.length) throw new Error("wallet-cli ring encrypt returned empty output");
  await writeFile(encPath, stdout);
  await run("sh", ["-c", `wallet-cli ring decrypt --key hedera-payment < "${encPath}" >/dev/null`]);
  console.log(`sealed → secrets/hedera.enc`);
}

await ensureWalletPass();
if (!process.env.WALLET_PASS) {
  console.error("WALLET_PASS missing — run npm run device first");
  process.exit(1);
}

const existingEnc = join(ROOT, "secrets/hedera.enc");
try {
  const enc = await readFile(existingEnc);
  await run("sh", ["-c", `wallet-cli ring decrypt --key hedera-payment < "${existingEnc}" >/dev/null`]);
  console.log("secrets/hedera.enc already exists — delete it to regenerate");
  process.exit(0);
} catch {
  /* fresh setup or corrupt enc — regenerate */
  await unlink(existingEnc).catch(() => {});
}

let privateKey;
let hex;
let evmAddress;

try {
  const pending = JSON.parse(await readFile(PENDING, "utf8"));
  if (!pending?.hex || !pending?.evmAddress) throw new Error("invalid pending");
  privateKey = PrivateKey.fromStringECDSA(pending.hex.replace(/^0x/, ""));
  hex = pending.hex.replace(/^0x/, "");
  evmAddress = pending.evmAddress;
  console.log("Resuming pending setup from secrets/.hedera-pending.json");
} catch {
  privateKey = PrivateKey.generateECDSA();
  hex = privateKey.toStringRaw();
  evmAddress = "0x" + privateKey.publicKey.toEvmAddress();
  await writeFile(
    PENDING,
    JSON.stringify({ evmAddress, hex, createdAt: new Date().toISOString() }, null, 2)
  );
  console.log("(saved pending key → secrets/.hedera-pending.json — gitignored)");
}

console.log("Hedera testnet payer (ECDSA)");
console.log(`  EVM address: ${evmAddress}`);
console.log(`  Faucet:      https://portal.hedera.com/faucet`);
console.log("  Paste the EVM address → RECEIVE 100 TESTNET HBAR (auto-creates hollow account)");

if (PAT) {
  console.log("\nFunding via HEDERA_PAT…");
  await fundViaPat(evmAddress);
} else if (!WAIT) {
  console.log("\nRe-run with --wait after funding, or set HEDERA_PAT for the Portal API.");
  console.log(`  npm run setup:hedera -- --wait`);
  process.exit(0);
}

const accountId = await pollMirror(evmAddress, "mirror");
await completeHollow(accountId, privateKey);
await sealKey(hex.replace(/^0x/, ""));
await unlink(PENDING).catch(() => {});

console.log(`\nexport MANDATE_HEDERA_ACCOUNT_ID=${accountId}`);
console.log("npm run e2e:payment");
