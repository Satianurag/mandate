#!/usr/bin/env node
/** Read-only funding readiness. No signing, key generation or transfers. */
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { createPublicClient, getAddress, http, erc20Abi, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { EXACT_USDC } from '../packages/gateway/src/agent-exact.ts';
const root = new URL('..', import.meta.url).pathname;
try {
  const cfg = parse(await readFile(`${root}/state/live/operator/active-mandate.yaml`, 'utf8'));
  let payer = getAddress(cfg.operatorAddress), deviceAddressMatches = null;
  if (process.argv.includes('--device')) {
    const { DmkEvmSigner } = await import('../packages/gateway/src/dmksigner.ts');
    const device = await DmkEvmSigner.create({ timeoutMs: 12000 });
    deviceAddressMatches = getAddress(device.address) === payer;
    if (!deviceAddressMatches) throw new Error('Connected Ledger differs from the saved payer; no funding target was prepared');
  }
  const rpc = createPublicClient({ chain: base, transport: http(base.rpcUrls.default.http[0], { timeout: 15000, retryCount: 0 }) });
  const asset = getAddress(EXACT_USDC['eip155:8453']);
  const [chainId, balance, nativeBalance, decimals] = await Promise.all([
    rpc.getChainId(), rpc.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [payer] }),
    rpc.getBalance({ address: payer }), rpc.readContract({ address: asset, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  if (chainId !== 8453 || decimals !== 6) throw new Error('RPC or USDC token does not match the observed Base mainnet x402 rail');
  console.log(JSON.stringify({ payer, network: 'eip155:8453', usdc: formatUnits(balance, decimals), ethForFundingGas: formatUnits(nativeBalance, 18), deviceAddressMatches, deviceSignatureRequested: false, fundsMoved: false }, null, 2));
} catch (e) { console.error(e instanceof Error ? e.message : 'Funding readiness check failed'); process.exitCode = 1; }
process.exit(process.exitCode ?? 0);
