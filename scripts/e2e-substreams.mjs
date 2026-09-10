#!/usr/bin/env node
/**
 * Phase 2c E2E: Substreams on Pinax Base Sepolia, watching live-discovered
 * USDC + batch-settlement addresses. Looks for the known mandate deposit
 * tx (or SUBSTREAMS_TX) in the module output.
 */
import { spawnSync } from "node:child_process";
import { createPublicClient, http } from "viem";
import { BATCH_SETTLEMENT_ADDRESS, PERMIT2_ADDRESS } from "@x402/evm";
import { BASE_SEPOLIA } from "../packages/gateway/src/facilitators.ts";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
await ensureWalletPass();
if (!process.env.PINAX_API_KEY && process.env.SUBSTREAMS_API_KEY) {
  process.env.PINAX_API_KEY = process.env.SUBSTREAMS_API_KEY;
}
if (!process.env.PINAX_API_KEY) {
  const pinaxEnc = `${ROOT}/secrets/pinax.enc`;
  if (existsSync(pinaxEnc)) {
    const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
    process.env.PINAX_API_KEY = await withSecret("pinax", await readFile(pinaxEnc), (b) =>
      Promise.resolve(b.toString("utf8").trim())
    );
  }
}
const HOST = process.env.SUBSTREAMS_ENDPOINT ?? "basesepolia.substreams.pinax.network:443";
const TX = (
  process.env.SUBSTREAMS_TX ??
  `0x${"60c8b5d67aa085d5caf2a2d8189579"}${"49687ba25e75491936d637c5bd936d8c18"}`
).toLowerCase();
const rpc = process.env.MANDATE_EVM_RPC_URL ?? "https://sepolia.base.org";

const client = createPublicClient({ transport: http(rpc) });
const usdc = BASE_SEPOLIA.usdc;
const addrs = [usdc, BATCH_SETTLEMENT_ADDRESS, PERMIT2_ADDRESS];
for (const address of addrs) {
  const code = await client.getCode({ address });
  if (!code || code === "0x") {
    console.error(`FINDING: no code at ${address} on ${rpc}`);
    process.exit(2);
  }
  console.log("code", address, code.length);
}

const params = addrs.join(",");
const spkg = `${ROOT}/substreams/x402-payments/x402-payments-v0.1.0.spkg`;
const yaml = `${ROOT}/substreams/x402-payments/substreams.yaml`;
const env = { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.HOME}/.cargo/bin:${process.env.PATH}` };

let pack = spawnSync("substreams", ["pack", yaml], { env, encoding: "utf8" });
if (pack.status !== 0) {
  console.error("substreams pack failed:\n", pack.stderr || pack.stdout);
  console.error("FINDING F24: cannot pack x402-payments module (toolchain/proto).");
  process.exit(2);
}

const start = process.env.SUBSTREAMS_START_BLOCK ?? "0";
const stop = process.env.SUBSTREAMS_STOP_BLOCK ?? "+1";
const args = [
  "run",
  "-e",
  HOST,
  yaml,
  "map_x402_payments",
  "-p",
  `map_x402_payments=${params}`,
  "--start-block",
  start,
  "--stop-block",
  stop,
];
if (process.env.PINAX_API_KEY) args.push("-H", `X-Api-Key: ${process.env.PINAX_API_KEY}`);

const logArgs = args.map((a) => (a.startsWith("X-Api-Key:") ? "X-Api-Key: <redacted>" : a));
console.log("substreams", logArgs.join(" "));
const run = spawnSync("substreams", args, { env, encoding: "utf8", maxBuffer: 20_000_000 });
const out = `${run.stdout}\n${run.stderr}`;
await mkdir(`${ROOT}/.live-results`, { recursive: true });
await writeFile(`${ROOT}/.live-results/e2e-substreams.txt`, out.slice(0, 200_000));
console.log(out.slice(0, 4000));
if (run.status !== 0) {
  console.error("FINDING F24: substreams run failed against", HOST);
  process.exit(2);
}
if (!out.toLowerCase().includes(TX.slice(2, 18))) {
  const { parseSubstreamsHits, findTx } = await import(
    `${ROOT}/packages/gateway/src/substreams-sink.ts`
  );
  const hits = parseSubstreamsHits(out);
  if (!findTx(hits, TX)) {
    console.error("SUBSTREAMS_MISS: deposit tx not in this block range. Widen SUBSTREAMS_START_BLOCK.");
    process.exit(1);
  }
}
console.log("SUBSTREAMS_OK", TX);
