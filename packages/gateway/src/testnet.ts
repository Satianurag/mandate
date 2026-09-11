/** Non-configurable safety boundary: this application has no mainnet mode. */
export const TESTNET_NETWORKS = ['eip155:84532', 'eip155:296', 'hedera:testnet'] as const;
export function assertTestnetNetwork(network: unknown): asserts network is typeof TESTNET_NETWORKS[number] {
  if (typeof network !== 'string' || !(TESTNET_NETWORKS as readonly string[]).includes(network)) {
    throw new Error(`Testnet-only: network ${String(network)} is not authorized`);
  }
}
export function assertTestnetChain(chainId: unknown): void {
  if (chainId !== 84532 && chainId !== 296 && chainId !== 84532n && chainId !== 296n) {
    throw new Error(`Testnet-only: chain ${String(chainId)} is not authorized for signing`);
  }
}
export function assertHederaTestnet(network: unknown): void {
  if (network !== 'testnet' && network !== 'hedera:testnet') throw new Error('Testnet-only: Hedera mainnet and previewnet are disabled');
}
