/**
 * Mandate testnet EVM chains, resolved from a live `eth_chainId` — never
 * assumed from a comment. Only Base Sepolia (84532) and Hedera testnet EVM
 * (296) are in scope.
 */

import { baseSepolia, type Chain } from "viem/chains";

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const HEDERA_TESTNET_EVM_CHAIN_ID = 296;
export const MANDATE_TESTNET_CHAIN_IDS = [BASE_SEPOLIA_CHAIN_ID, HEDERA_TESTNET_EVM_CHAIN_ID] as const;

export function caip2ForChainId(chainId: number): `eip155:${number}` {
  if (!(MANDATE_TESTNET_CHAIN_IDS as readonly number[]).includes(chainId)) {
    throw new Error(`chain ${chainId} is not a mandate testnet (84532 / 296).`);
  }
  return `eip155:${chainId}`;
}

export function viemChain(chainId: number, rpcUrl: string): Chain {
  if (chainId === BASE_SEPOLIA_CHAIN_ID) {
    return {
      ...baseSepolia,
      rpcUrls: { default: { http: [rpcUrl] }, public: { http: [rpcUrl] } },
    };
  }
  if (chainId === HEDERA_TESTNET_EVM_CHAIN_ID) {
    return {
      id: HEDERA_TESTNET_EVM_CHAIN_ID,
      name: "Hedera Testnet",
      nativeCurrency: { decimals: 18, name: "HBAR", symbol: "HBAR" },
      rpcUrls: { default: { http: [rpcUrl] }, public: { http: [rpcUrl] } },
    };
  }
  throw new Error(
    `RPC chain ${chainId} is not a mandate testnet (84532 Base Sepolia / 296 Hedera).`
  );
}
