#!/usr/bin/env node
/**
 * Unpaid Ledger preflight: loopback test CAL filters + physical address read.
 * Never signs a funding authorization, never settles, never broadcasts.
 */
import { createRequire } from 'node:module';
import { DmkEvmSigner } from '../../packages/gateway/src/dmksigner.ts';

const require = createRequire(import.meta.url);
const { ContextModuleBuilder, ContextModuleChainID } = require('@ledgerhq/context-module');
const { DeviceModelId } = require('@ledgerhq/device-management-kit');

const calUrl = process.env.MANDATE_LEDGER_TEST_CAL_URL?.trim() || 'http://127.0.0.1:8427';
const url = new URL(calUrl);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
  throw new Error('Ledger development CAL must be loopback HTTP');
}
process.env.MANDATE_LEDGER_TEST_CAL_URL = url.origin;

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const schema = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

const report = {
  ok: false,
  broadcast: false,
  funded: false,
  signatureCreated: false,
  cal: null,
  filters: null,
  address: null,
  error: null,
};

try {
  const health = await fetch(`${url.origin}/health`, { signal: AbortSignal.timeout(3000) });
  report.cal = await health.json();
  if (!health.ok || !report.cal?.ok) throw new Error('Loopback test CAL is not healthy');

  const contextModule = new ContextModuleBuilder({ originToken: '' })
    .setChain(ContextModuleChainID.Ethereum)
    .setCalConfig({ url: url.origin, mode: 'test', branch: 'main' })
    .build();
  const result = await contextModule.getTypedDataFilters({
    deviceModelId: DeviceModelId.NANO_SP,
    verifyingContract: USDC,
    chainId: 8453,
    version: 'v2',
    schema,
    fieldsValues: [],
  });
  if (result.type !== 'success') throw result.error;
  const filterNames = Object.keys(result.filters).sort();
  const expected = ['from', 'to', 'validAfter', 'validBefore', 'value'].sort();
  if (JSON.stringify(filterNames) !== JSON.stringify(expected)) {
    throw new Error(`unexpected ERC-7730 filters: ${filterNames.join(',')}`);
  }
  if (result.messageInfo.displayName !== 'Authorize USDC transfer') {
    throw new Error(`unexpected intent: ${result.messageInfo.displayName}`);
  }
  if (result.certificate !== undefined) throw new Error('physical CAL-test-key path must not load a PKI certificate');
  if (!result.tokens?.[255]) throw new Error('USDC test token metadata missing');
  report.filters = {
    type: result.type,
    intent: result.messageInfo.displayName,
    filters: filterNames,
    filterCount: result.messageInfo.filtersCount,
    certificatePresent: Boolean(result.certificate),
    tokenMetadata: Boolean(result.tokens[255]),
  };

  if (process.env.MANDATE_SKIP_DEVICE === '1') {
    report.ok = true;
  } else {
    const signer = await DmkEvmSigner.create({
      checkOnDevice: process.env.MANDATE_CHECK_ADDRESS_ON_DEVICE === '1',
      skipOpenApp: process.env.MANDATE_ETH_APP_OPEN === '1',
      timeoutMs: 90_000,
    });
    report.address = signer.address;
    report.signatureCreated = false;
    report.ok = true;
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
