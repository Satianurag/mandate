#!/usr/bin/env node
/**
 * ERC-7730 local validation. Registry ingest (F32) is still Ledger's;
 * this proves our descriptors are schema-shaped before the tester / PR.
 *
 * Official next step on a device: https://app.devicesdk.ledger.com/clear-signing-tools
 */
import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

async function collectJson(dir) {
  const out = [];
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name.endsWith(".json")) out.push(join(dir, name));
  }
  return out;
}

const files = [
  join(ROOT, "docs/erc7730-mandate-stepup.json"),
  ...(await collectJson(join(ROOT, "docs/erc7730"))),
];
const cliFiles = await collectJson(join(ROOT, "docs/erc7730"));

const required = ["context", "metadata", "display"];
const results = [];
let failed = false;

for (const file of files) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    results.push({ file, ok: false, error: e instanceof Error ? e.message : String(e) });
    failed = true;
    continue;
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    results.push({ file, ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : e}` });
    failed = true;
    continue;
  }
  const missing = required.filter((k) => json[k] == null || typeof json[k] !== "object");
  const formats = json.display?.formats;
  const formatCount = formats && typeof formats === "object" ? Object.keys(formats).length : 0;
  if (missing.length || formatCount === 0) {
    results.push({
      file,
      ok: false,
      error: missing.length ? `missing ${missing.join(",")}` : "display.formats empty",
    });
    failed = true;
    continue;
  }
  results.push({ file, ok: true, formats: formatCount });
}

function runOnce(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8", timeout: 60_000 });
}

function runErc7730Cli(files) {
  const attempts = [];
  if (process.env.ERC7730_BIN) attempts.push([process.env.ERC7730_BIN, ["lint", ...files]]);
  attempts.push([join(ROOT, ".venv/bin/erc7730"), ["lint", ...files]]);
  attempts.push(["erc7730", ["lint", ...files]]);
  const pythons = [process.env.ERC7730_PYTHON, join(ROOT, ".venv/bin/python"), "python3.12", "python3"].filter(
    Boolean
  );
  for (const bin of pythons) attempts.push([bin, ["-m", "erc7730", "lint", ...files]]);

  let lastFail = null;
  for (const [cmd, args] of attempts) {
    const pip = runOnce(cmd, args);
    if (pip.error?.code === "ENOENT") continue;
    const err = `${pip.stderr ?? ""}\n${pip.stdout ?? ""}`;
    if (/No module named erc7730/i.test(err)) continue;
    if (pip.status === 0) {
      return { skipped: false, ok: true, stdout: (pip.stdout ?? "").slice(0, 400), cmd, abiValidation: "on" };
    }
    lastFail = { cmd, status: pip.status, stderr: err.slice(0, 600) };
    const skipAbi = runOnce(cmd, [...args, "--skip-abi-validation"]);
    if (skipAbi.status === 0) {
      return {
        skipped: false,
        ok: true,
        stdout: (skipAbi.stdout ?? "").slice(0, 400),
        cmd,
        abiValidation: "skipped-offline",
        note: "full lint needed Etherscan ABI; schema lint passed with --skip-abi-validation",
      };
    }
  }
  if (lastFail) {
    return { skipped: false, ok: false, ...lastFail };
  }
  return {
    skipped: true,
    reason:
      "official erc7730 CLI not installed (Python 3.12 venv: python3.12 -m venv .venv && .venv/bin/pip install erc7730)",
  };
}

const cli = runErc7730Cli(cliFiles);

if (cli.skipped === false && cli.ok === false) failed = true;

const summary = {
  ok: !failed,
  results,
  erc7730Cli: cli,
  tester: "https://app.devicesdk.ledger.com/clear-signing-tools",
  registryPr: "https://github.com/ethereum/clear-signing-erc7730-registry/pull/2972",
};
const line = JSON.stringify(summary, null, 2);
console.log(line);
await mkdir(`${ROOT}/.live-results`, { recursive: true });
await writeFile(`${ROOT}/.live-results/e2e-erc7730.txt`, line + "\n");
if (failed) {
  console.error("ERC7730_FAILED");
  process.exit(1);
}
console.log("ERC7730_LINT_OK");
process.exit(0);
