#!/usr/bin/env node
/**
 * Create a distinct Hedera testnet merchant account (SERVICE_PAY_TO).
 * Stock exact@hedera:testnet cannot settle a self-transfer.
 *
 * Reuses `.live-results/service-pay-to.txt` when that account is still live.
 * The new account is keyed by the sealed operator so HBAR is recoverable.
 * maxAutomaticTokenAssociations=-1 so Circle HTS USDC can land without a
 * separate associate.
 *
 * Requires: secrets/hedera.enc, MANDATE_HEDERA_ACCOUNT_ID, WALLET_PASS.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
} from "@hiero-ledger/sdk";
import { ensureWalletPass } from "./load-wallet-pass.mjs";
import { SERVICE_PAY_TO_FILE } from "./resolve-pay-to.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1/accounts";
const payer = process.env.MANDATE_HEDERA_ACCOUNT_ID;

await ensureWalletPass();
if (!payer) {
  console.error("Missing MANDATE_HEDERA_ACCOUNT_ID");
  process.exit(1);
}

async function mirrorAccount(id) {
  const res = await fetch(`${MIRROR}/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`mirror ${res.status}`);
  return res.json();
}

try {
  const existing = (await readFile(SERVICE_PAY_TO_FILE, "utf8")).trim().split(/\s+/)[0];
  if (existing && existing !== payer) {
    const live = await mirrorAccount(existing);
    if (live?.account) {
      console.log(`MERCHANT_OK existing=${existing} (reused)`);
      process.env.SERVICE_PAY_TO = existing;
      process.exit(0);
    }
  }
} catch {
  // no cached merchant yet
}

const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
const enc = await readFile(`${ROOT}/secrets/hedera.enc`);

await withSecret("hedera-payment", enc, async (key) => {
  const hex = key.toString("utf8").trim().replace(/^0x/i, "");
  const pk = PrivateKey.fromStringECDSA(hex);
  const client = Client.forTestnet();
  try {
    client.setOperator(AccountId.fromString(payer), pk);
    const tx = await new AccountCreateTransaction()
      .setKey(pk.publicKey)
      .setInitialBalance(new Hbar(2))
      .setMaxAutomaticTokenAssociations(-1)
      .setAccountMemo("mandate SERVICE_PAY_TO")
      .execute(client);
    const receipt = await tx.getReceipt(client);
    const id = receipt.accountId?.toString();
    if (!id) {
      console.error("FINDING: AccountCreateTransaction succeeded without accountId");
      process.exit(2);
    }
    if (id === payer) {
      console.error("FINDING: merchant account id matched payer");
      process.exit(2);
    }
    await mkdir(`${ROOT}/.live-results`, { recursive: true });
    await writeFile(SERVICE_PAY_TO_FILE, id + "\n");
    process.env.SERVICE_PAY_TO = id;
    console.log(`MERCHANT_OK created=${id} autoAssoc=unlimited`);
    console.log(`export SERVICE_PAY_TO=${id}`);
  } finally {
    client.close();
  }
});
