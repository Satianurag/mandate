#!/usr/bin/env node
/**
 * Load WALLET_PASS from the OS keychain when unset.
 * Import: import { ensureWalletPass } from "./load-wallet-pass.mjs";
 *
 * macOS reads the Keychain (`security`); Linux reads Secret Service
 * (`secret-tool`, provided by libsecret). No other source exists by design:
 * the password must never be written into a command, a file, or CI output.
 */
import { spawn } from "node:child_process";

const SERVICE = "ledger-wallet-cli";
const ACCOUNT = "default";

function readPipe(cmd, args) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args);
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("error", () => resolve(""));
    c.on("close", (code) => resolve(code === 0 ? out.trim() : ""));
  });
}

export async function ensureWalletPass() {
  if (process.env.WALLET_PASS?.trim()) return process.env.WALLET_PASS.trim();
  const pass =
    process.platform === "darwin"
      ? await readPipe("security", [
          "find-generic-password",
          "-a",
          ACCOUNT,
          "-s",
          SERVICE,
          "-w",
        ])
      : await readPipe("secret-tool", [
          "lookup",
          "service",
          SERVICE,
          "account",
          ACCOUNT,
        ]);
  if (pass) process.env.WALLET_PASS = pass;
  return pass;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pass = await ensureWalletPass();
  if (!pass) {
    console.error("WALLET_PASS missing — run npm run device first");
    process.exit(1);
  }
  // --print is for shell capture (VAR=$(node load-wallet-pass.mjs --print)):
  // wallet-cli itself consumes WALLET_PASS from the environment, so shell
  // callers unavoidably hold it. Never log it.
  if (process.argv.includes("--print")) process.stdout.write(pass);
  else console.log("WALLET_PASS loaded from OS keychain");
}
