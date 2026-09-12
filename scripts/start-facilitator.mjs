#!/usr/bin/env node
/** Start the self-hosted x402 facilitator when Key Ring secrets exist. No-op otherwise. */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_URL = "http://127.0.0.1:8406";

async function secretsReady() {
  for (const file of ["secrets/mandate-facilitator.enc", "secrets/mandate-authorizer.enc"]) {
    try {
      await access(join(root, file));
    } catch {
      return false;
    }
  }
  return true;
}

async function waitForSupported(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/supported`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = await res.json();
        const kinds = (body.kinds ?? []).map(k => `${k.scheme}@${k.network}`);
        if (kinds.some(k => k === "exact@eip155:8453")) return true;
      }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

/**
 * @returns {{ child: ChildProcess | null, url: string | null, reason: string }}
 */
export async function maybeStartFacilitator(options = {}) {
  if (!(await secretsReady())) {
    return { child: null, url: null, reason: "Self-hosted facilitator secrets are not present; configure an external facilitator URL in Settings." };
  }
  const rpcUrl = options.rpcUrl ?? process.env.MANDATE_EVM_RPC_URL ?? "https://mainnet.base.org";
  const port = String(options.port ?? 8406);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", join(root, "packages/facilitator/src/index.ts")], {
    cwd: root,
    env: { ...process.env, MANDATE_EVM_RPC_URL: rpcUrl, FACILITATOR_PORT: port, FACILITATOR_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", chunk => process.stderr.write(chunk));
  child.stdout?.on("data", chunk => process.stderr.write(chunk));
  const ready = await waitForSupported(url);
  if (!ready) {
    child.kill("SIGTERM");
    return { child: null, url: null, reason: `Facilitator on ${url} did not advertise exact@eip155:8453 in time` };
  }
  return { child, url, reason: `Self-hosted facilitator listening on ${url}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await maybeStartFacilitator();
  if (!result.child) {
    console.error(result.reason);
    process.exit(1);
  }
  console.log(result.reason);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      result.child?.kill("SIGTERM");
      process.exit(0);
    });
  }
}

export { DEFAULT_URL };
