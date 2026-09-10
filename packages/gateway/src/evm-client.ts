/**
 * EVM x402 client (upto + exact) signed by Key Ring / Ledger — never an env key.
 */

import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { toClientEvmSigner, type ClientEvmSigner } from "@x402/evm";
import { createPublicClient, http } from "viem";
import { BASE_SEPOLIA } from "./facilitators.ts";
import { viemChain } from "./chains.ts";

export function createEvmX402Client(opts: {
  signer: ClientEvmSigner;
  rpcUrl: string;
  chainId?: number;
}): x402Client {
  const chainId = opts.chainId ?? 84532;
  const chain = viemChain(chainId, opts.rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  const signer = toClientEvmSigner(opts.signer, publicClient);
  const rpc = { rpcUrl: opts.rpcUrl };
  const network = `eip155:${chainId}` as const;
  return x402Client.fromConfig({
    schemes: [
      { network, client: new ExactEvmScheme(signer, rpc) },
      { network, client: new UptoEvmScheme(signer, rpc) },
    ],
    spendControls: {
      maxAmountPerPayment: false,
      allowedAssets: [{ network, asset: BASE_SEPOLIA.usdc }],
    },
  });
}
