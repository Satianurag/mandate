#!/usr/bin/env node
/**
 * Run all live verification gates and write evidence to .live-results/
 *
 * Usage: npm run live:gates
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(ROOT, ".live-results", stamp);

function run(cmd, args, opts = {}) {
  const actualArgs =
    cmd === process.execPath ? ["--experimental-strip-types", ...args] : args;
  return new Promise((resolve) => {
    const c = spawn(cmd, actualArgs, {
      cwd: ROOT,
      env: opts.env ?? process.env,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => {
      stdout += d;
      process.stdout.write(d);
    });
    c.stderr.on("data", (d) => {
      stderr += d;
      process.stderr.write(d);
    });
    c.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function gate(name, fn) {
  console.log(`\n=== ${name} ===`);
  const result = await fn();
  await writeFile(
    join(outDir, `${name.replace(/\s+/g, "-").toLowerCase()}.txt`),
    `${result.stdout}${result.stderr}\nexit=${result.code}\n`
  );
  return { ok: result.code === 0, result };
}

await mkdir(outDir, { recursive: true });
console.log(`Evidence → ${outDir}`);

await ensureWalletPass();

const log = [];

log.push(await gate("preflight", () => run("npm", ["run", "preflight"])));

log.push(
  await gate("ledger-genuine-check", () =>
    run(process.execPath, [join(ROOT, "scripts/ledger-genuine-check.mjs")])
  )
);

const readyGate = await gate("check-ready", () =>
  run(process.execPath, [join(ROOT, "scripts/check-ready.mjs")])
);
log.push(readyGate);

if (readyGate.ok) {
  log.push(
    await gate("e2e-payment", () => run(process.execPath, [join(ROOT, "scripts/e2e-payment.mjs")]))
  );

  if (!process.env.MANDATE_HCS_TOPIC_ID) {
    const prov = await gate("provision-hcs", () =>
      run(process.execPath, [join(ROOT, "scripts/provision-hcs.mjs")])
    );
    log.push(prov);
    const topic = /export MANDATE_HCS_TOPIC_ID=(0\.0\.\d+)/.exec(prov.result.stdout)?.[1];
    if (topic) {
      process.env.MANDATE_HCS_TOPIC_ID = topic;
      console.log(`\n(set MANDATE_HCS_TOPIC_ID=${topic} for this run)`);
    }
  }

  if (process.env.MANDATE_HCS_TOPIC_ID) {
    log.push(
      await gate("e2e-audit", () => run(process.execPath, [join(ROOT, "scripts/e2e-audit.mjs")]))
    );
  }
} else {
  console.log("\n(skip e2e-payment / HCS — check-ready failed)");
}

const mandateGate = await gate("check-mandate", () =>
  run(process.execPath, [join(ROOT, "scripts/check-mandate.mjs")])
);
log.push(mandateGate);

if (mandateGate.ok) {
  log.push(
    await gate("mandate-open", () => run(process.execPath, [join(ROOT, "scripts/mandate-open.mjs")]))
  );
} else {
  console.log("\n(skip mandate:open — check-mandate failed)");
}

log.push(
  await gate("probe-reputation", () =>
    run(process.execPath, [join(ROOT, "scripts/probe-reputation.mjs")])
  )
);

if (process.env.MANDATE_STEPUP_LIVE === "1") {
  log.push(
    await gate("e2e-stepup-device", () =>
      run(process.execPath, [join(ROOT, "scripts/e2e-stepup.mjs")])
    )
  );
} else {
  console.log("\n(skip e2e-stepup-device — set MANDATE_STEPUP_LIVE=1 with Ledger + Ethereum app)");
}

log.push(
  await gate("proxy-smoke", async () => {
    const svc = spawn(
      process.execPath,
      ["--experimental-strip-types", join(ROOT, "packages/service/src/index.ts")],
      { env: { ...process.env, SERVICE_PORT: "8411" }, stdio: "ignore" }
    );
    await new Promise((r) => setTimeout(r, 1500));
    try {
      // Fail fast on the step-up: no device is attached during gates, and a
      // real discovery cycle (5 attempts) would stall the suite for minutes.
      process.env.MANDATE_STEPUP_DISCOVER_MS = "3000";
      process.env.MANDATE_STEPUP_ATTEMPTS = "1";
      const { proxyFetch } = await import(`${ROOT}/packages/gateway/src/index.ts`);
      const url = "http://127.0.0.1:8411/analytics?q=%7B%20a%20%7B%20id%20%7D%20%7D";
      const res = await proxyFetch(url);
      const body = await res.text();
      const ok = res.status === 403 || res.status === 503;
      return {
        code: ok ? 0 : 1,
        stdout: `HTTP ${res.status}\n${body.slice(0, 500)}\n(expected 403 deny or 503 missing hedera key)\n`,
        stderr: "",
      };
    } finally {
      svc.kill();
    }
  })
);

const passed = log.filter((g) => g.ok).length;
const summary = {
  at: new Date().toISOString(),
  passed,
  total: log.length,
  gates: log.map((g, i) => ({ ok: g.ok })),
  note: "Full pass requires sealed keys, Hedera account, Base Sepolia wallet, Ledger on USB.",
};
await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

console.log(`\n=== Summary: ${passed}/${log.length} gates passed ===`);
console.log(`Evidence in ${outDir}`);
process.exit(passed === log.length ? 0 : 1);
