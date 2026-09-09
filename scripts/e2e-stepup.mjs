#!/usr/bin/env node
/** Live step-up — requires Ledger + Ethereum app (see docs/STEPUP.md). */
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createRequire } from "node:module";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
await ensureWalletPass();

function countLedgerHid() {
  try {
    const require = createRequire(join(ROOT, "packages/gateway/package.json"));
    const hid = require("node-hid");
    return hid.devices().filter((d) => d.vendorId === 0x2c97 && d.usagePage === 0xffa0).length;
  } catch {
    return -1;
  }
}

const hidCount = countLedgerHid();
if (hidCount === 0) {
  console.error("No Ledger HID device (usagePage 0xffa0). Plug in, unlock, open Ethereum app.");
  process.exit(1);
}

// Release HID from any stale wallet-cli / DMK session (Ledger agent-skills: no parallel device access).
spawnSync(process.execPath, [join(ROOT, "scripts/ledger-reset.mjs")], { stdio: "ignore" });

if (!process.env.MANDATE_STEPUP_STUB && process.env.MANDATE_ETH_APP_OPEN !== "1") {
  console.log("Waking device (ledger:check on dashboard — NOT inside Ethereum app)…");
  const wake = spawnSync(process.execPath, [join(ROOT, "scripts/ledger-genuine-check.mjs")], {
    env: {
      ...process.env,
      LEDGER_CHECK_ATTEMPTS: process.env.LEDGER_CHECK_ATTEMPTS ?? "3",
    },
    stdio: "inherit",
  });
  if (wake.status !== 0) {
    console.error(
      "Ledger not ready — unlock dashboard, disable auto-lock, quit Ledger Wallet desktop."
    );
    process.exit(1);
  }

  spawnSync(process.execPath, [join(ROOT, "scripts/ledger-reset.mjs")], { stdio: "ignore" });
  console.log(
    "\nOpen the Ethereum app on your Ledger (or let DMK open it — app must be installed).\n"
  );
} else if (process.env.MANDATE_ETH_APP_OPEN === "1") {
  console.log("Ethereum app already open — skipping dashboard genuine-check.");
  console.log("Review MandateStepUp fields (amount, recipient, policyReason) on device.\n");
}

const { requireDeviceApproval } = await import(`${ROOT}/packages/gateway/src/stepup.ts`);

const proposal = {
  origin: "http://127.0.0.1:8403",
  requirements: {
    scheme: "exact",
    network: "hedera:testnet",
    asset: "0.0.0",
    amount: "3100000",
    payTo: "0.0.7162784",
    maxTimeoutSeconds: 60,
    extra: { feePayer: "0.0.7162784" },
  },
  normalisedAmount: 0.031,
  assetSymbol: "HBAR",
};

console.log("Step-up test — confirm message on device (see docs/STEPUP.md)…");
console.log("Unlock Ledger if locked; approve when message appears.");
console.log("Set MANDATE_STEPUP_STUB=approve to skip device for CI.\n");

try {
  await requireDeviceApproval({
    proposal,
    reason: "e2e step-up probe (unregistered counterparty)",
    timeoutMs: Number(process.env.MANDATE_STEPUP_TIMEOUT_MS ?? 120_000),
  });
  console.log("STEPUP_OK");
} catch (e) {
  console.error("STEPUP_FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  spawnSync(process.execPath, [join(ROOT, "scripts/ledger-reset.mjs")], { stdio: "ignore" });
}
