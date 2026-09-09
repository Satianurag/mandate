/**
 * Mandate envelope — x402 `batch-settlement` on Base Sepolia.
 *
 * Maps the hardware-signed mandate budget to an on-chain escrow channel:
 *   deposit = budget, cumulative voucher = metered consumption.
 *
 * @see https://github.com/coinbase/x402/blob/main/specs/schemes/batch-settlement/batch_settlement.md
 */

import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { toClientEvmSigner } from "@x402/evm";
import {
  BatchSettlementEvmScheme,
  computeChannelId,
  buildChannelConfig,
  InMemoryClientChannelStorage,
  type BatchSettlementClientDeps,
} from "@x402/evm/batch-settlement/client";
import { privateKeyToAccount } from "viem/accounts";
import { padHex, toHex } from "viem";
import type { PaymentRequirements } from "@x402/core/types";
import { BASE_SEPOLIA, X402_FOUNDATION } from "./facilitators.ts";

export { computeChannelId, buildChannelConfig, InMemoryClientChannelStorage };
export { BASE_SEPOLIA, X402_FOUNDATION };

/** Fixed bytes32 salt — UTF-8 "mandate" zero-padded (not ASCII padEnd on a hex string). */
export const MANDATE_CHANNEL_SALT = padHex(toHex(new TextEncoder().encode("mandate")), {
  size: 32,
}) as `0x${string}`;

export interface EnvelopeClientOptions {
  /** Hex-encoded secp256k1 signing key for the mandate payer (testnet). */
  privateKey: `0x${string}`;
  salt?: `0x${string}`;
  rpcUrl?: string;
}

/** Build an x402 client wired for batch-settlement on Base Sepolia. */
export function createEnvelopeClient(options: EnvelopeClientOptions) {
  const account = privateKeyToAccount(options.privateKey);
  const signer = toClientEvmSigner(account);
  const scheme = new BatchSettlementEvmScheme(signer, {
    salt: options.salt ?? MANDATE_CHANNEL_SALT,
    storage: new InMemoryClientChannelStorage(),
    ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
  });
  return new x402Client().register(BASE_SEPOLIA.caip2, scheme);
}

/** Payment-enabled fetch — opens or draws on the batch-settlement channel. */
export function createEnvelopeFetch(options: EnvelopeClientOptions) {
  return wrapFetchWithPayment(fetch, createEnvelopeClient(options));
}

/** Derive the channel id for server payment requirements. */
export function channelIdForRequirements(
  deps: BatchSettlementClientDeps,
  requirements: PaymentRequirements
): `0x${string}` {
  const config = buildChannelConfig(deps, requirements);
  return computeChannelId(config, BASE_SEPOLIA.caip2);
}

export const ENVELOPE_FACILITATOR = X402_FOUNDATION;
