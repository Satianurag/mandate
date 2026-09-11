#!/usr/bin/env node
/**
 * Phase 3b: stock batch-settlement@eip155:296.
 *
 * 1. Facilitator advertises 296 next to 84532.
 * 2. Key Ring Hedera payer holds Circle HTS USDC (0.0.429274).
 * 3. Merchant 402 uses extra.assetTransferMethod=permit2 — HTS USDC has no
 *    EIP-3009 (measured: version()/DOMAIN_SEPARATOR empty).
 * 4. Paid deposit uses stock BatchSettlementEvmScheme. CREATE2 escrow
 *    accounts are lazy-created and immutable (max_auto_associations=0);
 *    HIP-904 airdrop is pending and unclaimable by the contract. If settle
 *    cannot complete, that is a FINDING — not a stub deposit.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, erc20Abi } from "viem";
import { parse } from "yaml";
import { TokenId } from "@hiero-ledger/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { toClientEvmSigner } from "@x402/evm";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const FAC_PORT = 8426;
const SVC_PORT = 8425;
const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";
const BATCH = "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003";
const P2COLLECTOR = "0x4020425FAf3B746C082C2f942b4E5159887B0005";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
await ensureWalletPass();

let baseRpc = process.env.MANDATE_EVM_RPC_URL;
let receiver = process.env.MANDATE_SERVICE_RECEIVER;
if (existsSync(`${ROOT}/mandate.yaml`)) {
  const m = parse(await readFile(`${ROOT}/mandate.yaml`, "utf8"));
  if (typeof m?.rpcUrl === "string") {
    baseRpc = baseRpc ?? m.rpcUrl;
    process.env.MANDATE_EVM_RPC_URL = baseRpc;
  }
  if (typeof m?.receiver === "string") receiver = receiver ?? m.receiver;
}
if (!baseRpc) {
  console.error("Missing MANDATE_EVM_RPC_URL (or mandate.yaml rpcUrl)");
  process.exit(1);
}
if (!receiver || !/^0x[0-9a-fA-F]{40}$/.test(receiver)) {
  console.error("Need MANDATE_SERVICE_RECEIVER or mandate.yaml receiver");
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
const { CIRCLE_HEDERA_TESTNET_USDC_HTS } = await import(
  `${ROOT}/packages/gateway/src/facilitators.ts`
);
const { viemChain } = await import(`${ROOT}/packages/gateway/src/chains.ts`);

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

const usdc = `0x${TokenId.fromString(CIRCLE_HEDERA_TESTNET_USDC_HTS).toEvmAddress()}`;
const payerAccount = privateKeyToAccount(`0x${ecdsa32(hederaSubmitter).toString("hex")}`);
const hederaClient = createPublicClient({
  chain: viemChain(296, hederaRpc),
  transport: http(hederaRpc),
});
const [symbol, decimals, balance] = await Promise.all([
  hederaClient.readContract({ address: usdc, abi: erc20Abi, functionName: "symbol" }),
  hederaClient.readContract({ address: usdc, abi: erc20Abi, functionName: "decimals" }),
  hederaClient.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [payerAccount.address],
  }),
]);
console.log(
  JSON.stringify({
    usdc,
    symbol,
    decimals: Number(decimals),
    payer: payerAccount.address,
    balance: balance.toString(),
  })
);
if (balance === 0n) {
  console.error(
    "FINDING: Hedera batch contracts are live and /supported lists eip155:296, but the Key Ring Hedera payer holds 0 Circle USDC (HTS 0.0.429274)."
  );
  hederaSubmitter.fill(0);
  process.exit(2);
}
console.log("HEDERA_BATCH_USDC_OK");

async function escrowStatus(evm) {
  const res = await fetch(`${MIRROR}/accounts/${evm}`);
  const body = await res.json();
  const tokens = await fetch(
    `${MIRROR}/accounts/${evm}/tokens?token.id=${CIRCLE_HEDERA_TESTNET_USDC_HTS}`
  );
  const listedTokens = tokens.ok ? await tokens.json() : { tokens: [] };
  const pending = await fetch(`${MIRROR}/accounts/${evm}/airdrops/pending?limit=5`);
  const pendingBody = pending.ok ? await pending.json() : { airdrops: [] };
  return {
    evm,
    account: body.account,
    max_automatic_token_associations: body.max_automatic_token_associations,
    memo: body.memo,
    associated: Array.isArray(listedTokens.tokens) && listedTokens.tokens.length > 0,
    pendingAirdrops: pendingBody.airdrops ?? [],
  };
}

const escrow = {
  batch: await escrowStatus(BATCH),
  permit2Collector: await escrowStatus(P2COLLECTOR),
  permit2: await escrowStatus(PERMIT2),
};
console.log("escrow", JSON.stringify(escrow));
const associated = escrow.batch.associated && escrow.permit2Collector.associated;
if (!associated) {
  console.log(
    "HTS_ESCROW_UNASSOCIATED CREATE2 accounts are lazy-created/immutable; TokenAssociate=INVALID_SIGNATURE; ContractUpdate=MODIFYING_IMMUTABLE_CONTRACT; HIP-904 airdrop is pending (unclaimable by the contract)."
  );
}

const kids = [];
const spawnTs = (file, env) => {
  const c = spawn(process.execPath, ["--experimental-strip-types", file], {
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  kids.push(c);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHttp(url, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status) return res;
    } catch {
      /* not up yet */
    }
    await wait(400);
  }
  throw new Error(`timeout waiting for ${url}`);
}

spawnTs(`${ROOT}/packages/facilitator/src/index.ts`, { FACILITATOR_PORT: String(FAC_PORT) });
await waitHttp(`http://127.0.0.1:${FAC_PORT}/supported`);
const dir = await mkdtemp(join(tmpdir(), "hedera-batch-"));
spawnTs(`${ROOT}/packages/mandate-service/src/index.ts`, {
  MANDATE_SERVICE_PORT: String(SVC_PORT),
  MANDATE_FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
  MANDATE_SERVICE_STATE: dir,
  MANDATE_SERVICE_CHAIN_ID: "296",
  MANDATE_SERVICE_RPC_URL: hederaRpc,
  MANDATE_SERVICE_RECEIVER: receiver,
  MANDATE_SERVICE_ASSET: usdc,
  MANDATE_HEDERA_EVM_RPC_URL: hederaRpc,
});
await waitHttp(`http://127.0.0.1:${SVC_PORT}/analytics`);

const analytics = `http://127.0.0.1:${SVC_PORT}/analytics`;
let code = 2;
try {
  const unpaid = await fetch(analytics);
  if (unpaid.status !== 402) {
    console.error("HEDERA_BATCH_FAILED: expected 402", unpaid.status, await unpaid.text());
  } else {
    const offer = decodePaymentRequiredHeader(unpaid.headers.get("payment-required") ?? "");
    const accept = offer.accepts[0];
    const extra = accept?.extra ?? {};
    console.log(
      "offer",
      accept?.scheme,
      accept?.network,
      accept?.asset,
      "transfer",
      extra.assetTransferMethod ?? "eip3009-default"
    );
    if (accept?.scheme !== "batch-settlement" || accept?.network !== "eip155:296") {
      console.error("HEDERA_BATCH_FAILED: merchant did not offer batch-settlement@eip155:296");
    } else if (extra.assetTransferMethod !== "permit2") {
      console.error(
        "HEDERA_BATCH_FAILED: HTS USDC has no EIP-3009; 402 must set extra.assetTransferMethod=permit2"
      );
    } else {
      console.log("HEDERA_BATCH_OFFER_OK");
      const { openKeyRingMandate } = await import(`${ROOT}/packages/gateway/src/mandate.ts`);
      const payer = toClientEvmSigner(payerAccount, hederaClient);
      const salt = `0x${randomBytes(32).toString("hex")}`;
      const sealedSession = await readFile(`${ROOT}/secrets/mandate-session.enc`);
      const mandate = await openKeyRingMandate({
        scope: {
          network: "eip155:296", serviceUrl: analytics, asset: usdc, receiver,
          receiverAuthorizer: extra.receiverAuthorizer, withdrawDelay: extra.withdrawDelay,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          ceilingBaseUnits: "30000", perCallBaseUnits: "30000", windowBaseUnits: "30000", windowMs: 3600000,
        },
        rpcUrl: hederaRpc,
        storageRoot: dir,
        sessionKeyName: "mandate-session",
        sealedSessionKey: sealedSession,
        ceilingBaseUnits: "30000",
        salt,
        chainId: 296,
        payer,
        allowedAssets: [
          { network: "eip155:296", asset: usdc, maxAmountPerPayment: "30000" },
        ],
      });
      try {
        if (mandate.payer.toLowerCase() === receiver.toLowerCase()) {
          throw new Error("receiver equals Hedera payer — self-channels are rejected");
        }
        console.log(`payer ${mandate.payer} session ${mandate.session} salt ${salt}`);
        const wallet = createWalletClient({
          account: payerAccount,
          chain: viemChain(296, hederaRpc),
          transport: http(hederaRpc),
        });
        const allowance = await hederaClient.readContract({
          address: usdc,
          abi: erc20Abi,
          functionName: "allowance",
          args: [payerAccount.address, PERMIT2],
        });
        if (allowance < 30000n) {
          const approveHash = await wallet.writeContract({
            address: usdc,
            abi: erc20Abi,
            functionName: "approve",
            args: [PERMIT2, 30000n],
            gas: 2_000_000n,
          });
          const receipt = await hederaClient.waitForTransactionReceipt({ hash: approveHash });
          console.log("APPROVE_PERMIT2", approveHash, receipt.status);
        } else {
          console.log("APPROVE_PERMIT2_ALREADY", allowance.toString());
        }
        const res = await mandate.fetch(`${analytics}?q=${encodeURIComponent("{ agents(first: 5) { id agentId agentWallet totalFeedback } }")}`);
        const text = await res.text();
        console.log("HTTP", res.status, text.slice(0, 800));
        await mkdir(`${ROOT}/.live-results`, { recursive: true });
        if (res.status === 200 && !text.includes("agent-demo-1")) {
          console.log("HEDERA_BATCH_PAID_OK");
          await writeFile(
            `${ROOT}/.live-results/e2e-hedera-batch.txt`,
            ["HEDERA_BATCH_PAID_OK", `payer ${mandate.payer}`, `http ${res.status}`, text.slice(0, 400)].join(
              "\n"
            ) + "\n"
          );
          code = 0;
        } else {
          const reason = `HTTP ${res.status} associated=${associated} batch.max_auto=${escrow.batch.max_automatic_token_associations}`;
          console.error("FINDING F28: stock permit2 deposit did not settle on eip155:296.", reason);
          await writeFile(
            `${ROOT}/.live-results/e2e-hedera-batch.txt`,
            [
              "HEDERA_BATCH_HTS_BLOCKED",
              reason,
              `offer permit2@eip155:296 asset ${accept.asset}`,
              `body ${text.slice(0, 600)}`,
              JSON.stringify(escrow),
            ].join("\n") + "\n"
          );
          console.log("HEDERA_BATCH_HTS_BLOCKED");
          code = 2;
        }
      } finally {
        mandate.close();
      }
    }
  }
} catch (e) {
  console.error("HEDERA_BATCH_FAILED:", e instanceof Error ? e.message : e);
  code = 2;
} finally {
  hederaSubmitter.fill(0);
  for (const k of kids) k.kill("SIGTERM");
}
process.exit(code);
