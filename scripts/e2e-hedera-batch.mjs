#!/usr/bin/env node
/**
 * Phase 3b: stock batch-settlement@eip155:296 on the self-hosted facilitator.
 * Registers Hashio via x402 `.register` (same scheme as 84532). Paid
 * mandate:open is refused when the Hedera submitter holds 0 Circle USDC
 * (HTS 0.0.429274) — FINDING, no stub deposit.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createPublicClient, http, erc20Abi } from "viem";
import { parse } from "yaml";
import { TokenId } from "@hiero-ledger/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
await ensureWalletPass();

let baseRpc = process.env.MANDATE_EVM_RPC_URL;
if (!baseRpc && existsSync(`${ROOT}/mandate.yaml`)) {
  const m = parse(await readFile(`${ROOT}/mandate.yaml`, "utf8"));
  if (typeof m?.rpcUrl === "string") {
    baseRpc = m.rpcUrl;
    process.env.MANDATE_EVM_RPC_URL = baseRpc;
  }
}
if (!baseRpc) {
  console.error("Missing MANDATE_EVM_RPC_URL (or mandate.yaml rpcUrl)");
  process.exit(1);
}
const hederaRpc = process.env.MANDATE_HEDERA_EVM_RPC_URL ?? "https://testnet.hashio.io/api";
const hederaEnc = `${ROOT}/secrets/hedera.enc`;
if (!existsSync(hederaEnc)) {
  console.error("FINDING: secrets/hedera.enc missing — cannot register eip155:296");
  process.exit(2);
}

const { unseal } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
const { buildCore, ecdsa32 } = await import(`${ROOT}/packages/facilitator/src/index.ts`);

const keys = {
  submitter: await unseal("mandate-facilitator", await readFile(`${ROOT}/secrets/mandate-facilitator.enc`)),
  authorizer: await unseal("mandate-authorizer", await readFile(`${ROOT}/secrets/mandate-authorizer.enc`)),
};
const hederaSubmitter = await unseal("hedera-payment", await readFile(hederaEnc));
let kinds;
try {
  let core = await buildCore(baseRpc, keys);
  core = await buildCore(
    hederaRpc,
    { submitter: hederaSubmitter, authorizer: keys.authorizer },
    core
  );
  kinds = core.getSupported().kinds;
} finally {
  keys.submitter.fill(0);
  keys.authorizer.fill(0);
}

const listed = kinds.map((k) => `${k.scheme}@${k.network}`);
console.log("supported", listed.join(" "));
if (!listed.includes("batch-settlement@eip155:296")) {
  console.error("FINDING: facilitator did not advertise batch-settlement@eip155:296");
  process.exit(2);
}
if (!listed.includes("batch-settlement@eip155:84532")) {
  console.error("FINDING: facilitator dropped batch-settlement@eip155:84532 while adding 296");
  process.exit(2);
}
console.log("HEDERA_BATCH_SUPPORTED_OK");

const usdc = `0x${TokenId.fromString("0.0.429274").toEvmAddress()}`;
const submitter = privateKeyToAccount(`0x${ecdsa32(hederaSubmitter).toString("hex")}`);
hederaSubmitter.fill(0);
const client = createPublicClient({ transport: http(hederaRpc) });
const [symbol, decimals, balance] = await Promise.all([
  client.readContract({ address: usdc, abi: erc20Abi, functionName: "symbol" }),
  client.readContract({ address: usdc, abi: erc20Abi, functionName: "decimals" }),
  client.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [submitter.address],
  }),
]);
console.log(
  JSON.stringify({
    usdc,
    symbol,
    decimals: Number(decimals),
    payer: submitter.address,
    balance: balance.toString(),
  })
);
if (balance === 0n) {
  console.error(
    "FINDING: Hedera batch contracts are live and /supported lists eip155:296, but the Key Ring Hedera payer holds 0 Circle USDC (HTS 0.0.429274). Paid mandate:open@296 is not possible until that HTS is funded. Ledger EVM 0x57a2… is not a Hedera account (Hashio INVALID_ACCOUNT_ID)."
  );
  process.exit(2);
}
console.log("HEDERA_BATCH_USDC_OK");
