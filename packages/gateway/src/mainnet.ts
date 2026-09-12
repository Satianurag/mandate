/** Mainnet-only signing boundary. No testnet authority can be reused. */
export const MAINNET_NETWORKS = ['eip155:8453'] as const;
export function assertMainnetNetwork(network: unknown): asserts network is typeof MAINNET_NETWORKS[number] {
  if (network !== 'eip155:8453') throw new Error(`Mainnet-only: network ${String(network)} is not authorized; use Base mainnet`);
}
export function assertMainnetChain(chainId: unknown): void {
  if (chainId !== 8453 && chainId !== 8453n) throw new Error(`Mainnet-only: chain ${String(chainId)} is not authorized for signing`);
}
export function assertHederaDisabled(_network: unknown): void {
  throw new Error('Native Hedera payments are disabled: this application settles USDC on Base mainnet');
}
