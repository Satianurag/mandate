#!/usr/bin/env node
/**
 * Live ERC-7730 / Clear Signing proof on a connected Ledger.
 *
 * Signs the same EIP-3009 type mandate:open uses (USDC ReceiveWithAuthorization
 * on Base Sepolia). validAfter is ~10 years in the future so the signature
 * cannot be settled. Never broadcast. Never X402_PRIVATE_KEY.
 *
 * Classifies the DMK state machine:
 *   erc7730       — CAL provided context; labeled ERC-7730 fields
 *   legacy-eip712 — Ethereum app built-in EIP-712 viewer (usedFallback)
 *   blind         — hash-only path
 *
 * CAL /dapps is probed first (no device). Registry ingest (F32) is Ledger's.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { recoverTypedDataAddress } from "viem";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BATCH = "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const CAL = "https://global.api.prd.ledger.com/cal/v1/dapps";
const REGISTRY_PR = "https://github.com/ethereum/clear-signing-erc7730-registry/pull/2972";

await ensureWalletPass();

const receiveTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

async function probeCal(address, chainId, originToken) {
  const url = new URL(CAL);
  url.searchParams.set("contracts", address);
  url.searchParams.set("chain_id", String(chainId));
  url.searchParams.set("output", "descriptors_eip712");
  url.searchParams.set("descriptors_eip712_version", "v2");
  url.searchParams.set("descriptors_eip712", "<set>");
  url.searchParams.set("ref", "branch:main");
  const headers = {
    Accept: "application/json",
    "X-Ledger-Client-Version": "context-module/2.5.0",
  };
  if (originToken) headers["X-Ledger-Client-Origin"] = originToken;
  const started = Date.now();
  let status = 0;
  let bytes = 0;
  let descriptorKeys = 0;
  let error = undefined;
  try {
    const res = await fetch(url, { headers });
    status = res.status;
    const text = await res.text();
    bytes = text.length;
    if (res.ok) {
      try {
        const json = JSON.parse(text);
        const rows = Array.isArray(json) ? json : [];
        for (const row of rows) {
          const byAddr = row?.descriptors_eip712?.[address.toLowerCase()];
          if (byAddr && typeof byAddr === "object") descriptorKeys += Object.keys(byAddr).length;
        }
      } catch {
        /* body is not JSON — still record status */
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return {
    address,
    chainId,
    originTokenPresent: Boolean(originToken),
    status,
    bytes,
    descriptorKeys,
    ms: Date.now() - started,
    error,
  };
}

const { loadLedgerOriginToken } = await import(`${ROOT}/packages/gateway/src/origin-token.ts`);
const originToken = await loadLedgerOriginToken();

const cal = {
  usdc84532: await probeCal(USDC, 84532, originToken),
  batch84532: await probeCal(BATCH, 84532, originToken),
  permit284532: await probeCal(PERMIT2, 84532, originToken),
};
console.log("CAL", JSON.stringify(cal, null, 2));

spawnSync(process.execPath, [join(ROOT, "scripts/ledger-reset.mjs")], { stdio: "ignore" });

if (process.env.MANDATE_ETH_APP_OPEN !== "1") {
  console.log("Open the Ethereum app on the Ledger, then re-run with MANDATE_ETH_APP_OPEN=1.");
  console.log("Continuing — DMK will try to open the Ethereum app if it is installed.\n");
} else {
  console.log("Ethereum app already open — skipOpenApp=1.\n");
}

console.error(">>> Confirm / approve USDC ReceiveWithAuthorization on the Ledger.");
console.error("    validAfter is ~10 years ahead — this authorization cannot settle.\n");

const { DmkEvmSigner } = await import(`${ROOT}/packages/gateway/src/dmksigner.ts`);
let summary;
try {
  const device = await DmkEvmSigner.create({
    timeoutMs: Number(process.env.MANDATE_STEPUP_TIMEOUT_MS ?? 120_000),
    skipOpenApp: process.env.MANDATE_ETH_APP_OPEN === "1",
  });
  const now = Math.floor(Date.now() / 1000);
  const typedData = {
    domain: {
      name: "USDC",
      version: "2",
      chainId: 84532,
      verifyingContract: USDC,
    },
    types: receiveTypes,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: device.address,
      to: device.address,
      value: "1",
      validAfter: String(now + 10 * 365 * 24 * 3600),
      validBefore: String(now + 11 * 365 * 24 * 3600),
      nonce: `0x${randomBytes(32).toString("hex")}`,
    },
  };
  const signature = await device.signTypedData(typedData);
  const recovered = await recoverTypedDataAddress({
    ...typedData,
    signature,
  });
  if (recovered.toLowerCase() !== device.address.toLowerCase()) {
    throw new Error(`recovered ${recovered} != device ${device.address}`);
  }
  const report = device.lastClearSigning;
  const labeled = report?.verdict === "erc7730";
  summary = {
    ok: true,
    labeledClearSigning: labeled,
    originTokenPresent: Boolean(originToken),
    calFilters: report?.calFilters ?? "none",
    address: device.address,
    recovered,
    primaryType: typedData.primaryType,
    verifyingContract: USDC,
    chainId: 84532,
    validAfter: typedData.message.validAfter,
    signatureLength: signature.length,
    clearSigning: report,
    cal,
    registryPr: REGISTRY_PR,
    tester: "https://app.devicesdk.ledger.com/clear-signing-tools",
  };
  const tag =
    report?.verdict === "erc7730"
      ? "ERC7730_DEVICE_CLEAR"
      : report?.verdict === "clear-basic"
        ? "ERC7730_DEVICE_BASIC"
        : report?.verdict === "legacy-eip712"
          ? "ERC7730_DEVICE_LEGACY"
          : report?.verdict === "blind"
            ? "ERC7730_DEVICE_BLIND"
            : "ERC7730_DEVICE_UNKNOWN";
  console.log(tag, JSON.stringify({ verdict: report?.verdict, calFilters: report?.calFilters, steps: report?.steps, labeled }));
} catch (e) {
  summary = {
    ok: false,
    labeledClearSigning: false,
    originTokenPresent: Boolean(originToken),
    error: e instanceof Error ? e.message : String(e),
    cal,
    registryPr: REGISTRY_PR,
  };
  console.error("ERC7730_DEVICE_FAILED:", summary.error);
  process.exitCode = 1;
} finally {
  spawnSync(process.execPath, [join(ROOT, "scripts/ledger-reset.mjs")], {
    stdio: "ignore",
    timeout: 8_000,
  });
}

await mkdir(`${ROOT}/.live-results`, { recursive: true });
await writeFile(`${ROOT}/.live-results/e2e-erc7730-device.txt`, `${JSON.stringify(summary, null, 2)}\n`);
process.exit(process.exitCode ?? 0);
