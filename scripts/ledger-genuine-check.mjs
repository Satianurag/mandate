#!/usr/bin/env node
/**
 * Reliable Ledger genuine-check with retries (handles sleep / slow wake / PIN unlock).
 *
 * Uses wallet-device.mjs per Ledger agent-skills: do not kill while awaiting PIN.
 *
 * Usage: npm run ledger:check
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const attempts = Number(process.env.LEDGER_CHECK_ATTEMPTS ?? 8);
const deviceTimeoutMs = Number(process.env.LEDGER_DEVICE_TIMEOUT_MS ?? 120_000);

await ensureWalletPass();

async function releaseDevice() {
  await new Promise((resolve) => {
    const c = spawn(process.execPath, [join(ROOT, "scripts/ledger-reset.mjs")], {
      stdio: "ignore",
    });
    c.on("close", () => resolve());
  });
}

function runCheck() {
  return new Promise((resolve) => {
    const c = spawn(
      process.execPath,
      [
        join(ROOT, "scripts/wallet-device.mjs"),
        "genuine-check",
        "--output",
        "json",
        "--device-timeout",
        String(deviceTimeoutMs),
      ],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    c.stdout.on("data", (d) => {
      out += d;
      process.stdout.write(d);
    });
    c.stderr.on("data", (d) => {
      out += d;
      process.stderr.write(d);
    });
    c.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

for (let i = 1; i <= attempts; i++) {
  await releaseDevice();

  if (i > 1) {
    console.log(
      `\nretry ${i}/${attempts} — unlock dashboard, disable auto-lock, quit Ledger Wallet desktop`
    );
    await new Promise((r) => setTimeout(r, 4000));
  }

  const { out } = await runCheck();
  if (out.includes('"genuine": true') || out.includes('"genuine":true')) {
    process.exit(0);
  }
}

console.error(`
Ledger not ready. Latest fixes (Ledger docs 2026):
  1. Settings → Security → Auto-lock → Never (or max)
  2. Stay on dashboard (not inside Ethereum app) for genuine-check
  3. Quit Ledger Wallet desktop (it holds USB)
  4. Install/update Ethereum app via My Ledger if step-up fails with "Unknown application name"
  5. Only one device command at a time — scripts now release HID before each attempt
`);
process.exit(1);
