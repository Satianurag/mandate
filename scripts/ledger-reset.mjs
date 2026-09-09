#!/usr/bin/env node
/**
 * Release USB HID — kill stale wallet-cli device processes before a new command.
 * Ledger agent-skills: two concurrent device commands corrupt APDU exchange.
 */
import { execSync } from "node:child_process";

const patterns = [
  "wallet-cli genuine-check",
  "wallet-cli ring init",
  "wallet-cli account discover",
  "wallet-cli receive",
  "wallet-cli send",
  "ledger-genuine-check",
];

for (const p of patterns) {
  try {
    execSync(`pkill -f "${p}" 2>/dev/null || true`, { stdio: "ignore" });
  } catch {
    /* ignore */
  }
}
