#!/usr/bin/env node
/** Pre-code checklist status from docs/plan.md — no secrets read. */

import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

async function exists(p) {
  try {
    await access(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function env(name) {
  return Boolean(process.env[name]?.trim());
}

function row(ok, label, hint) {
  console.log(`${ok ? "✓" : "○"} ${label}${hint ? `\n    → ${hint}` : ""}`);
  return ok;
}

const items = [];

const graphSealed = await exists(join(ROOT, "secrets/graph.enc"));
items.push(
  row(
    graphSealed,
    "Graph Studio API key sealed (secrets/graph.enc)",
    graphSealed ? undefined : "npm run seal:keys"
  )
);

const hederaSealed = await exists(join(ROOT, "secrets/hedera.enc"));
let pendingEvm;
try {
  pendingEvm = JSON.parse(await readFile(join(ROOT, "secrets/.hedera-pending.json"), "utf8")).evmAddress;
} catch {
  pendingEvm = undefined;
}
items.push(
  row(
    hederaSealed && env("MANDATE_HEDERA_ACCOUNT_ID"),
    "Hedera testnet account + sealed payment key",
    hederaSealed
      ? "export MANDATE_HEDERA_ACCOUNT_ID=0.0.xxxxx"
      : pendingEvm
        ? `fund ${pendingEvm} at portal.hedera.com/faucet → npm run setup:hedera -- --wait`
        : "npm run setup:hedera → fund faucet → npm run setup:hedera -- --wait"
  )
);

items.push(
  row(
    env("MANDATE_EVM_SIGNING_KEY") && env("MANDATE_EVM_RECEIVER"),
    "Base Sepolia ETH + USDC wallet env",
    "export MANDATE_EVM_SIGNING_KEY=0x… MANDATE_EVM_RECEIVER=0x…"
  )
);

await ensureWalletPass();

const ledgerOk = await new Promise((resolve) => {
  const c = spawn(process.execPath, [join(ROOT, "scripts/ledger-genuine-check.mjs")], {
    env: process.env,
  });
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  c.stderr.on("data", (d) => (out += d));
  c.on("close", (code) =>
    resolve(code === 0 || out.includes('"genuine": true') || out.includes('"genuine":true'))
  );
});
items.push(
  row(
    ledgerOk,
    "Ledger connected and genuine",
    "unlock dashboard; npm run ledger:check — disable device auto-lock if it sleeps"
  )
);

const pass = await new Promise((resolve) => {
  if (process.env.WALLET_PASS) return resolve(true);
  const c = spawn("security", [
    "find-generic-password",
    "-a",
    "default",
    "-s",
    "ledger-wallet-cli",
    "-w",
  ]);
  c.on("close", (code) => resolve(code === 0));
});
items.push(row(pass, "Key Ring password in Keychain", "npm run device"));

console.log(`\n${items.filter(Boolean).length}/${items.length} ready — run npm run live:gates when all ✓`);
process.exit(items.every(Boolean) ? 0 : 1);
