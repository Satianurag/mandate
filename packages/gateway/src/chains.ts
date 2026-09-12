import { base, type Chain } from "viem/chains";
export const BASE_MAINNET_CHAIN_ID = 8453;
export function caip2ForChainId(chainId: number): `eip155:${number}` {
  if (chainId !== BASE_MAINNET_CHAIN_ID) throw new Error(`chain ${chainId} is not Base mainnet`);
  return `eip155:${chainId}`;
}
export function viemChain(chainId: number, rpcUrl: string): Chain {
  caip2ForChainId(chainId);
  return { ...base, rpcUrls: { default: { http: [rpcUrl] } } };
}
