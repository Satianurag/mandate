#!/usr/bin/env node
/**
 * Run wallet-cli device commands without killing during PIN unlock.
 *
 * Ledger agent-skills (2026): on `device-state … awaiting_approval … unlock`,
 * keep the command running — CLI resumes automatically once unlocked.
 * Do NOT hard-timeout like `wct.mjs` does for locked devices.
 *
 * Usage: node scripts/wallet-device.mjs genuine-check --output json --device-timeout 120000
 */
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/wallet-device.mjs <wallet-cli args...>");
  process.exit(2);
}

const maxMs = Number(process.env.WALLET_DEVICE_MAX_MS ?? 180_000);
const idleMs = Number(process.env.WALLET_DEVICE_IDLE_MS ?? 120_000);

let out = "";
let lastActivity = Date.now();
let unlockMsgShown = false;
const startTime = Date.now();

function bumpActivity() {
  lastActivity = Date.now();
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return;
  try {
    const j = JSON.parse(trimmed);
    if (j.type === "device-state" && j.state?.code === "awaiting_approval") {
      if (j.state.reason === "unlock") {
        if (!unlockMsgShown) {
          unlockMsgShown = true;
          process.stderr.write(
            "\n>>> Ledger locked — enter PIN on device (waiting, not killing)…\n\n"
          );
        }
        bumpActivity();
      }
    }
    if (j.message && /locked|unlock|PIN/i.test(j.message)) bumpActivity();
  } catch {
    /* partial json line */
  }
}

function handleChunk(chunk) {
  const text = chunk.toString();
  process.stdout.write(text);
  out += text;
  bumpActivity();
  for (const line of text.split("\n")) parseLine(line);
}

const child = spawn("wallet-cli", args, {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", handleChunk);
child.stderr.on("data", handleChunk);

const watchdog = setInterval(() => {
  const elapsed = Date.now() - startTime;
  const idle = Date.now() - lastActivity;

  if (elapsed > maxMs) {
    process.stderr.write(`\nMax wait ${maxMs}ms — unlock Ledger, disable auto-lock, retry.\n`);
    child.kill("SIGKILL");
  } else if (idle > idleMs && !unlockMsgShown) {
    process.stderr.write(
      `\nNo device activity for ${idleMs}ms — plug in, unlock dashboard, quit Ledger Wallet desktop.\n`
    );
    child.kill("SIGKILL");
  }
}, 2000);

child.on("close", (code) => {
  clearInterval(watchdog);
  if (out.includes('"genuine": true') || out.includes('"genuine":true')) {
    process.exit(0);
  }
  process.exit(code ?? 1);
});
