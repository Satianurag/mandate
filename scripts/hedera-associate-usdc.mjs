#!/usr/bin/env node
/**
 * Associate Circle Hedera testnet USDC (HTS 0.0.429274) with the Key Ring
 * payer so the Circle faucet can credit it. Official path from
 * https://github.com/hedera-dev/x402-hedera (associate, then faucet.circle.com).
 * Testnet only. Never X402_PRIVATE_KEY.
 */
import { readFile } from "node:fs/promises";
import {
  AccountId,
  Client,
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
} from "@hiero-ledger/sdk";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const USDC = TokenId.fromString("0.0.429274");
const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";

await ensureWalletPass();
const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
const enc = await readFile(`${ROOT}/secrets/hedera.enc`);

await withSecret("hedera-payment", enc, async (key) => {
  const hex = key.toString("utf8").trim().replace(/^0x/i, "");
  const pk = PrivateKey.fromStringECDSA(hex);
  const evm = pk.publicKey.toEvmAddress();
  const evmPrefixed = evm.startsWith("0x") ? evm : `0x${evm}`;
  let accountId = process.env.MANDATE_HEDERA_ACCOUNT_ID;
  if (!accountId) {
    const res = await fetch(`${MIRROR}/accounts/${evmPrefixed}`);
    if (!res.ok) {
      console.error(`FINDING: mirror lookup failed for ${evmPrefixed} (${res.status})`);
      process.exit(2);
    }
    const body = await res.json();
    accountId = typeof body.account === "string" ? body.account : body.accounts?.[0]?.account;
  }
  if (!accountId) {
    console.error("FINDING: no Hedera account id for the sealed ECDSA key");
    process.exit(2);
  }
  const client = Client.forTestnet();
  try {
    client.setOperator(AccountId.fromString(accountId), pk);
    const assoc = await fetch(`${MIRROR}/accounts/${accountId}/tokens?token.id=${USDC.toString()}`);
    const listed = assoc.ok ? await assoc.json() : { tokens: [] };
    if (Array.isArray(listed.tokens) && listed.tokens.length > 0) {
      console.log(`USDC_ALREADY_ASSOCIATED account=${accountId} token=${USDC.toString()}`);
      console.log(`Next: https://faucet.circle.com — network Hedera Testnet — account ${accountId}`);
      return;
    }
    const tx = await new TokenAssociateTransaction()
      .setAccountId(AccountId.fromString(accountId))
      .setTokenIds([USDC])
      .execute(client);
    const receipt = await tx.getReceipt(client);
    console.log(`USDC_ASSOCIATED account=${accountId} status=${receipt.status.toString()}`);
    console.log(`Next: https://faucet.circle.com — network Hedera Testnet — account ${accountId}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/TOKEN_ALREADY_ASSOCIATED/i.test(msg)) {
      console.log(`USDC_ALREADY_ASSOCIATED account=${accountId} token=${USDC.toString()}`);
      console.log(`Next: https://faucet.circle.com — network Hedera Testnet — account ${accountId}`);
      return;
    }
    console.error("FINDING: TokenAssociateTransaction failed:", msg);
    process.exit(2);
  } finally {
    client.close();
  }
});
