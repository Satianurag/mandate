#!/usr/bin/env node
/**
 * Phase 3a E2E: upto@eip155:84532 — authorize max, settle actual < max.
 * One Ledger tap if Permit2 allowance requires it. Never X402_PRIVATE_KEY.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapFetchWithPayment } from "@x402/fetch";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} from "@x402/core/http";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const FAC_PORT = 8416;
const SVC_PORT = 8415;

await ensureWalletPass();
let rpc = process.env.MANDATE_EVM_RPC_URL;
let receiver = process.env.MANDATE_SERVICE_RECEIVER;
if (!rpc || !receiver) {
  try {
    const { parseMandateFile } = await import(`${ROOT}/packages/gateway/src/mandate-config.ts`);
    const m = parseMandateFile(await readFile(`${ROOT}/mandate.yaml`, "utf8"));
    process.env.MANDATE_EVM_RPC_URL ??= m.rpcUrl;
    process.env.MANDATE_SERVICE_RECEIVER ??= m.receiver;
    rpc = process.env.MANDATE_EVM_RPC_URL;
    receiver = process.env.MANDATE_SERVICE_RECEIVER;
  } catch {
    /* fall through */
  }
}
if (!rpc || !receiver) {
  console.error("Need MANDATE_EVM_RPC_URL and MANDATE_SERVICE_RECEIVER (or mandate.yaml)");
  process.exit(1);
}

const dir = await mkdtemp(join(tmpdir(), "upto-"));
const kids = [];
const spawnTs = (file, env) => {
  const c = spawn(process.execPath, ["--experimental-strip-types", file], {
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  kids.push(c);
};
spawnTs(`${ROOT}/packages/facilitator/src/index.ts`, { FACILITATOR_PORT: String(FAC_PORT) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHttp(url, timeoutMs = 45_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status) return;
    } catch {
      /* not up yet */
    }
    await wait(400);
  }
  throw new Error(`timeout waiting for ${url}`);
}
await waitHttp(`http://127.0.0.1:${FAC_PORT}/supported`);
spawnTs(`${ROOT}/packages/mandate-service/src/index.ts`, {
  MANDATE_SERVICE_PORT: String(SVC_PORT),
  MANDATE_FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
  MANDATE_SERVICE_STATE: dir,
});
await waitHttp(`http://127.0.0.1:${SVC_PORT}/usage`);

let code = 1;
try {
  const url = `http://127.0.0.1:${SVC_PORT}/usage`;
  const unpaid = await fetch(url);
  if (unpaid.status !== 402) {
    console.error("UPTO_FAILED: expected 402", unpaid.status, await unpaid.text());
  } else {
    const offer = decodePaymentRequiredHeader(unpaid.headers.get("payment-required") ?? "");
    const max = offer.accepts[0]?.amount;
    console.log("upto offer max", max, "scheme", offer.accepts[0]?.scheme);
    console.log(
      "upto 402 extensions",
      JSON.stringify(offer.extensions ?? {}),
      "extra",
      JSON.stringify(offer.accepts[0]?.extra ?? {})
    );
    if (offer.accepts[0]?.scheme !== "upto") {
      console.error("UPTO_FAILED: merchant did not offer upto");
    } else if (!offer.extensions || !("eip2612GasSponsoring" in offer.extensions)) {
      console.error("UPTO_FAILED: 402 missing eip2612GasSponsoring");
    } else {
      const { DmkEvmSigner } = await import(`${ROOT}/packages/gateway/src/dmksigner.ts`);
      const { createEvmX402Client } = await import(`${ROOT}/packages/gateway/src/evm-client.ts`);
      const device = await DmkEvmSigner.create({
        timeoutMs: Number(process.env.MANDATE_STEPUP_TIMEOUT_MS ?? 120_000),
      });
      const x402 = createEvmX402Client({ signer: device, rpcUrl: rpc, chainId: 84532 });
      const tapFetch = async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const pay = req.headers.get("payment-signature") ?? req.headers.get("PAYMENT-SIGNATURE");
        if (pay) {
          try {
            const p = decodePaymentSignatureHeader(pay);
            const ext = p.extensions ?? {};
            const keys = Object.keys(ext);
            const sig = ext.eip2612GasSponsoring?.info?.signature;
            const v = typeof sig === "string" && sig.length >= 2 ? sig.slice(-2) : "none";
            console.log(`payment-signature extensions=[${keys.join(",") || "none"}] eip2612.v=0x${v}`);
          } catch (e) {
            console.log("payment-signature decode failed", e instanceof Error ? e.message : e);
          }
        }
        return fetch(input, init);
      };
      const paid = await wrapFetchWithPayment(tapFetch, x402)(url);
      const text = await paid.text();
      console.log("HTTP", paid.status, text.slice(0, 800));
      if (paid.status !== 200) {
        console.error("UPTO_FAILED: settlement did not return 200");
      } else if (text.includes("agent-demo-1")) {
        console.error("UPTO_FAILED: mock row leaked into paid body");
      } else {
        const parsed = JSON.parse(text);
        const settled = parsed.paid?.amount;
        console.log("authorised max", max, "settled actual", settled);
        if (max && settled && BigInt(settled) >= BigInt(max)) {
          console.error("UPTO_FAILED: actual was not < max");
        } else {
          const pr = paid.headers.get("payment-response");
          let payer = "";
          let tx = parsed.paid?.txHash ?? "";
          if (pr) {
            const decoded = decodePaymentResponseHeader(pr);
            console.log("payment-response", JSON.stringify(decoded).slice(0, 400));
            payer = decoded.payer ?? "";
            tx = decoded.transaction ?? tx;
          }
          console.log("device taps", device.signCalls);
          console.log("UPTO_OK");
          const { mkdir, writeFile } = await import("node:fs/promises");
          await mkdir(`${ROOT}/.live-results`, { recursive: true });
          await writeFile(
            `${ROOT}/.live-results/e2e-upto.txt`,
            ["UPTO_OK", `max ${max} settled ${settled}`, `taps ${device.signCalls}`, `payer ${payer}`, `tx ${tx}`].join(
              "\n"
            ) + "\n"
          );
          code = 0;
        }
      }
    }
  }
} catch (e) {
  console.error("UPTO_FAILED:", e instanceof Error ? e.message : e);
} finally {
  for (const k of kids) k.kill("SIGTERM");
}
process.exit(code);
