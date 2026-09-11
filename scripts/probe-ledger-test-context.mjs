#!/usr/bin/env node
/**
 * Non-device proof that Ledger ContextModule consumes the loopback development
 * CAL bridge and resolves our Base Sepolia USDC ERC-7730 typed-data filters.
 * No signature and no transaction are created here.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ContextModuleBuilder, ContextModuleChainID } = require('@ledgerhq/context-module');
const { DeviceModelId } = require('@ledgerhq/device-management-kit');

const calUrl = process.env.MANDATE_LEDGER_TEST_CAL_URL?.trim() || 'http://127.0.0.1:8427';
const url = new URL(calUrl);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
  throw new Error('Ledger development CAL must be loopback HTTP');
}

const schema = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

const contextModule = new ContextModuleBuilder({ originToken: '' })
  .setChain(ContextModuleChainID.Ethereum)
  .setCalConfig({ url: url.origin, mode: 'test', branch: 'main' })
  .build();

const result = await contextModule.getTypedDataFilters({
  deviceModelId: DeviceModelId.NANO_SP,
  verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  chainId: 84532,
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

console.log(JSON.stringify({
  ok: true,
  mode: 'test',
  network: 'eip155:84532',
  deviceModel: DeviceModelId.NANO_SP,
  intent: result.messageInfo.displayName,
  filters: filterNames,
  filterCount: result.messageInfo.filtersCount,
  certificatePresent: Boolean(result.certificate),
  tokenMetadata: Boolean(result.tokens[255]),
  broadcast: false,
}, null, 2));
