#!/usr/bin/env node
/**
 * Create a distinct Hedera treasury account, fund it, seal the ECDSA key
 * as Key Ring name `treasury` → secrets/treasury.enc.
 * Live gate: npm run treasury:topup
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
} from "@hiero-ledger/sdk";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const ENC = `${ROOT}/secrets/treasury.enc`;
const ID_FILE = `${ROOT}/.live-results/treasury-id.txt`;
const payer = process.env.MANDATE_HEDERA_ACCOUNT_ID;

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

await ensureWalletPass();
if (!process.env.WALLET_PASS) {
  console.error("WALLET_PASS missing — run npm run device first");
  process.exit(1);
}
if (!payer) {
  console.error("Missing MANDATE_HEDERA_ACCOUNT_ID");
  process.exit(1);
}

try {
  await access(ENC, constants.R_OK);
  await run("sh", ["-c", `wallet-cli ring decrypt --key treasury < "${ENC}" >/dev/null`]);
  let id = process.env.MANDATE_TREASURY_ID;
  try {
    id = (await readFile(ID_FILE, "utf8")).trim() || id;
  } catch {
    /* no cached id */
  }
  console.log(`TREASURY_OK existing secrets/treasury.enc${id ? ` id=${id}` : ""}`);
  if (id) console.log(`export MANDATE_TREASURY_ID=${id}`);
  process.exit(0);
} catch {
  /* create */
}

const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
const payerEnc = await readFile(`${ROOT}/secrets/hedera.enc`);
const treasuryKey = PrivateKey.generateECDSA();
const hex = treasuryKey.toStringRaw().replace(/^0x/, "");

await withSecret("hedera-payment", payerEnc, async (key) => {
  const payerPk = PrivateKey.fromStringECDSA(key.toString("utf8").trim().replace(/^0x/i, ""));
  const client = Client.forTestnet();
  try {
    client.setOperator(AccountId.fromString(payer), payerPk);
    const tx = await new AccountCreateTransaction()
      .setKey(treasuryKey.publicKey)
      .setInitialBalance(new Hbar(5))
      .setMaxAutomaticTokenAssociations(-1)
      .setAccountMemo("mandate treasury HIP-423")
      .execute(client);
    const receipt = await tx.getReceipt(client);
    const id = receipt.accountId?.toString();
    if (!id) {
      console.error("FINDING: treasury AccountCreateTransaction had no accountId");
      process.exit(2);
    }
    const { stdout } = await run("wallet-cli", ["ring", "encrypt", "--key", "treasury"], hex, true);
    if (!stdout.length) throw new Error("wallet-cli ring encrypt returned empty output");
    await writeFile(ENC, stdout);
    await run("sh", ["-c", `wallet-cli ring decrypt --key treasury < "${ENC}" >/dev/null`]);
    await mkdir(`${ROOT}/.live-results`, { recursive: true });
    await writeFile(ID_FILE, id + "\n");
    process.env.MANDATE_TREASURY_ID = id;
    console.log(`TREASURY_OK created=${id} sealed=secrets/treasury.enc`);
    console.log(`export MANDATE_TREASURY_ID=${id}`);
  } finally {
    client.close();
  }
});
