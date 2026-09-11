#!/usr/bin/env node
/**
 * Run the official ERC-7730 descriptor lint and report separately proven
 * physical-device evidence. Registry acceptance remains an independent gate.
 */
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const descriptors = (await readdir(join(root, 'docs/erc7730')))
  .filter((name) => name.endsWith('.json'))
  .map((name) => join(root, 'docs/erc7730', name));
if (!descriptors.length) throw new Error('No current descriptor files exist');

const executable = process.env.ERC7730_BIN ??
  (existsSync(join(root, '.venv/bin/erc7730')) ? join(root, '.venv/bin/erc7730') : 'erc7730');
const schemaOnly = process.argv.includes('--schema-only');
const args = ['lint', ...(schemaOnly ? ['--skip-abi-validation'] : []), ...descriptors];
const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', timeout: 60_000 });

const proofRelativePath = 'docs/verification/ledger-erc7730-device-2026-09-11.json';
const proofPath = join(root, proofRelativePath);
let runtimeDeviceDisplayVerified = false;
let runtimeDeviceDisplayEvidence = 'missing';

if (existsSync(proofPath)) {
  try {
    const proof = JSON.parse(await readFile(proofPath, 'utf8'));
    const physical = proof?.physicalDevice;
    const clearSigning = physical?.clearSigning;
    const steps = Array.isArray(clearSigning?.steps) ? clearSigning.steps : [];
    const address = String(physical?.address ?? '').toLowerCase();
    const recovered = String(physical?.recovered ?? '').toLowerCase();
    const validAddress = /^0x[0-9a-f]{40}$/.test(address);

    runtimeDeviceDisplayVerified =
      proof?.format === 'mandate-ledger-erc7730-device-proof-v1' &&
      proof?.network === 'eip155:84532' &&
      proof?.testnetOnly === true &&
      proof?.developmentCal?.mode === 'ledger-cal-test-key' &&
      proof?.developmentCal?.loopbackOnly === true &&
      physical?.labeledClearSigning === true &&
      clearSigning?.verdict === 'erc7730' &&
      clearSigning?.calFilters === 'success' &&
      steps.includes('signer.eth.steps.provideContext') &&
      steps.includes('signer.eth.steps.signTypedData') &&
      !steps.includes('signer.eth.steps.signTypedDataLegacy') &&
      physical?.broadcast === false &&
      physical?.fundsMoved === 0 &&
      validAddress &&
      address === recovered;

    runtimeDeviceDisplayEvidence = runtimeDeviceDisplayVerified
      ? `${proofRelativePath} (Ledger CAL test-key development mode)`
      : `${proofRelativePath} (present but proof invariants failed)`;
  } catch (error) {
    runtimeDeviceDisplayEvidence = `${proofRelativePath} (unreadable: ${error instanceof Error ? error.message : String(error)})`;
  }
}

const report = {
  checkedAt: new Date().toISOString(),
  status: result.error?.code === 'ENOENT'
    ? 'tooling_unavailable'
    : result.status === 0
      ? (schemaOnly ? 'schema_only' : 'full_lint_passed')
      : 'failed',
  abiValidation: !schemaOnly,
  descriptorFiles: descriptors.map((file) => file.slice(root.length)),
  runtimeDeviceDisplayVerified,
  runtimeDeviceDisplayEvidence,
  registryAcceptanceVerified: false,
  output: `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-12_000),
};

await mkdir(join(root, '.live-results/repair'), { recursive: true });
await writeFile(join(root, '.live-results/repair/erc7730-lint.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

if (report.status === 'tooling_unavailable') process.exitCode = 2;
else if (result.status !== 0) process.exitCode = 1;
