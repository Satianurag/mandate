#!/usr/bin/env node
/**
 * Load WALLET_PASS from macOS Keychain when unset.
 * Import: import { ensureWalletPass } from "./load-wallet-pass.mjs";
 */
import { spawn } from "node:child_process";

export function ensureWalletPass() {
  if (process.env.WALLET_PASS?.trim()) return process.env.WALLET_PASS.trim();
  return new Promise((resolve) => {
    const c = spawn("security", [
      "find-generic-password",
      "-a",
      "default",
      "-s",
      "ledger-wallet-cli",
      "-w",
    ]);
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", (code) => {
      const pass = code === 0 ? out.trim() : "";
      if (pass) process.env.WALLET_PASS = pass;
      resolve(pass);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pass = await ensureWalletPass();
  if (pass) console.log("WALLET_PASS loaded from Keychain");
  else {
    console.error("WALLET_PASS missing — run npm run device first");
    process.exit(1);
  }
}
