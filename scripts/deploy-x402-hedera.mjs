#!/usr/bin/env node
/**
 * Official x402 forge deploy against Hedera testnet (Hashio), only if
 * Permit2 + CREATE2 already have code (F28). Never invents bytecode.
 * Deployer key is unsealed from the Key Ring — never X402_PRIVATE_KEY.
 *
 * Official scripts (x402 contracts/evm README):
 *   script/DeployBatchSettlement.s.sol  → batch + ERC3009 collector
 *   script/Deploy.s.sol                 → Permit2 proxies (exact + upto)
 *
 * Hashio rejects Foundry object block tags; we front it with
 * scripts/hashio-rpc-proxy.mjs (transport rewrite only).
 */
import { spawn, spawnSync } from "node:child_process";
import { createPublicClient, http } from "viem";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BATCH_SETTLEMENT_ADDRESS,
  ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
  PERMIT2_ADDRESS,
  x402UptoPermit2ProxyAddress,
} from "@x402/evm";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const HASHIO = process.env.HEDERA_EVM_RPC_URL ?? "https://testnet.hashio.io/api";
const CREATE2 = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const client = createPublicClient({ transport: http(HASHIO) });
const chainId = await client.getChainId();
if (chainId !== 296) {
  console.error("Hashio chainId", chainId, "!= 296");
  process.exit(2);
}

async function codeAt(address) {
  const code = await client.getCode({ address });
  return code && code !== "0x" ? (code.length - 2) / 2 : 0;
}

const permit2 = await codeAt(PERMIT2_ADDRESS);
const create2 = await codeAt(CREATE2);
const batch = await codeAt(BATCH_SETTLEMENT_ADDRESS);
const collector = await codeAt(ERC3009_DEPOSIT_COLLECTOR_ADDRESS);
const upto = await codeAt(x402UptoPermit2ProxyAddress);
console.log(JSON.stringify({ chainId, permit2, create2, batch, collector, upto }, null, 2));

if (permit2 === 0 || create2 === 0) {
  console.error("FINDING F28: Permit2 or CREATE2 missing on Hedera EVM — cannot stock-deploy.");
  process.exit(2);
}
if (batch > 0 && collector > 0) {
  console.log("HEDERA_BATCH_ALREADY_DEPLOYED", BATCH_SETTLEMENT_ADDRESS);
  process.exit(0);
}

const forge = `${process.env.HOME}/.foundry/bin/forge`;
const which = spawnSync(forge, ["--version"], { encoding: "utf8" });
if (which.status !== 0) {
  console.error("FINDING F28: forge not installed; cannot run official DeployBatchSettlement.s.sol");
  process.exit(2);
}

const dir = "/tmp/x402-contracts";
if (!existsSync(`${dir}/contracts/evm`)) {
  const clone = spawnSync(
    "git",
    ["clone", "--depth", "1", "https://github.com/x402-foundation/x402.git", dir],
    { encoding: "utf8" }
  );
  if (clone.status !== 0) {
    console.error(clone.stderr);
    process.exit(2);
  }
}

await ensureWalletPass();
const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
const encPath = process.env.MANDATE_HEDERA_EVM_KEY_ENC ?? `${ROOT}/secrets/hedera.enc`;
let hex;
try {
  const enc = await readFile(encPath);
  const name = process.env.MANDATE_HEDERA_EVM_KEY_NAME ?? "hedera-payment";
  hex = await withSecret(name, enc, (b) =>
    Promise.resolve(b.toString("utf8").trim().replace(/^0x/, ""))
  );
} catch (e) {
  console.error(
    "FINDING F28: cannot unseal Hedera EVM deployer from Key Ring:",
    e instanceof Error ? e.message : e
  );
  console.error(
    "Seal a funded Hedera ECDSA key as secrets/hedera.enc. Never X402_PRIVATE_KEY."
  );
  process.exit(2);
}
if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
  // Keys sealed as raw 32 bytes (facilitator style) rather than utf8 hex.
  const enc = await readFile(encPath);
  const raw = await withSecret(
    process.env.MANDATE_HEDERA_EVM_KEY_NAME ?? "hedera-payment",
    enc,
    (b) => Promise.resolve(b)
  );
  hex = Buffer.isBuffer(raw) ? raw.toString("hex") : String(raw);
}
if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
  console.error(
    "FINDING F28: unsealed deployer is not a 32-byte hex key (Hedera DER keys cannot drive forge)."
  );
  process.exit(2);
}

const proxyPort = Number(process.env.HASHIO_PROXY_PORT ?? 8549);
const proxy = spawn(process.execPath, [`${ROOT}/scripts/hashio-rpc-proxy.mjs`, String(proxyPort)], {
  stdio: ["ignore", "ignore", "inherit"],
  env: { ...process.env, HEDERA_EVM_RPC_URL: HASHIO },
});
await new Promise((r) => setTimeout(r, 400));
const rpc = `http://127.0.0.1:${proxyPort}`;

const evmDir = `${dir}/contracts/evm`;
const build = spawnSync(forge, ["build"], {
  cwd: evmDir,
  encoding: "utf8",
  env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" },
});
if (build.status !== 0) {
  console.error("FINDING F28: forge build of official x402 contracts failed");
  console.error((build.stderr || build.stdout).slice(0, 2000));
  proxy.kill("SIGTERM");
  process.exit(2);
}

const ksDir = await mkdtemp(join(tmpdir(), "x402-ks-"));
const ksPass = randomBytes(16).toString("hex");
const castBin = `${process.env.HOME}/.foundry/bin/cast`;
const imported = spawnSync(
  castBin,
  [
    "wallet",
    "import",
    "x402-deployment-signer",
    "--keystore-dir",
    ksDir,
    "--private-key",
    `0x${hex}`,
    "--unsafe-password",
    ksPass,
  ],
  { encoding: "utf8" }
);
if (imported.status !== 0) {
  console.error("FINDING F28: cast wallet import failed (x402 README uses this keystore path)");
  console.error(imported.stderr || imported.stdout);
  process.exit(2);
}
const senderOut = spawnSync(castBin, ["wallet", "address", "--private-key", `0x${hex}`], {
  encoding: "utf8",
});
const sender = senderOut.stdout.trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(sender)) {
  console.error("FINDING F28: could not derive deployer address from Key Ring key");
  process.exit(2);
}

const scripts = [
  existsSync(`${evmDir}/script/DeployBatchSettlement.s.sol`)
    ? "script/DeployBatchSettlement.s.sol"
    : null,
  existsSync(`${evmDir}/script/Deploy.s.sol`) ? "script/Deploy.s.sol" : null,
].filter(Boolean);

let combined = "";
try {
  for (const script of scripts) {
    // Official x402 contracts/evm README:
    // forge script script/Deploy.s.sol --rpc-url <RPC> --account <signer> --sender <addr> --broadcast
    // Hedera Foundry docs: forge script ... --rpc-url $HEDERA_RPC_URL --broadcast
    console.error(`Running official x402 ${script} (README flags: --broadcast --account, no skip-simulation).`);
    const run = spawnSync(
      forge,
      [
        "script",
        script,
        "--rpc-url",
        rpc,
        "--keystore",
        join(ksDir, "x402-deployment-signer"),
        "--password",
        ksPass,
        "--sender",
        sender,
        "--broadcast",
        "--slow",
      ],
      {
        cwd: evmDir,
        encoding: "utf8",
        env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" },
      }
    );
    combined += `\n===== ${script} exit=${run.status} =====\n${run.stdout}\n${run.stderr}\n`;
  }
} finally {
  hex = "0".repeat(64);
  proxy.kill("SIGTERM");
  await rm(ksDir, { recursive: true, force: true });
}

await mkdir(`${ROOT}/.live-results`, { recursive: true });
const redacted = combined.replace(/0x[a-fA-F0-9]{64}/g, "0x<redacted>");
await writeFile(`${ROOT}/.live-results/hedera-batch-deploy.txt`, redacted.slice(0, 50_000));
console.log(redacted.slice(0, 4000));

const batchAfter = await codeAt(BATCH_SETTLEMENT_ADDRESS);
if (batchAfter === 0) {
  console.error("FINDING F28: official forge deploy did not leave code at", BATCH_SETTLEMENT_ADDRESS);
  process.exit(2);
}
console.log("HEDERA_BATCH_DEPLOYED", BATCH_SETTLEMENT_ADDRESS, "bytes", batchAfter);
process.exit(0);
