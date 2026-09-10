/**
 * Hedera specifics: amount normalisation and the sealed signer.
 *
 * Everything else is stock: transaction assembly and partial signing live in
 * `@x402/hedera`'s `createClientHederaSigner`, the wire format in
 * `@x402/core`, and facilitator transport in `HTTPFacilitatorClient`. This
 * module holds only what the SDK cannot know -- how to read a human amount
 * out of v2 requirements, and how to keep the key sealed while signing.
 */

import {
  PrivateKey,
  HBAR_ASSET_ID,
  createClientHederaSigner,
  type ClientHederaSigner,
} from "@x402/hedera";
import type { PaymentRequirements } from "@x402/core/types";
import { BASE_SEPOLIA, CIRCLE_HEDERA_TESTNET_USDC_HTS } from "./facilitators.ts";
import { withSecret } from "./keyring.ts";

/** Circle Hedera testnet USDC (6 decimals). Stock ExactHederaScheme asset. */
export const DEFAULT_HTS_DECIMALS: Record<string, number> = {
  [CIRCLE_HEDERA_TESTNET_USDC_HTS]: 6,
};

/** Circle Base Sepolia USDC (6 decimals). Graph testnet x402 + upto@84532. */
export const DEFAULT_EVM_DECIMALS: Record<string, number> = {
  [BASE_SEPOLIA.usdc.toLowerCase()]: 6,
};

/** Tinybars per HBAR. Exact integer; normalisation divides by this. */
export const TINYBARS_PER_HBAR = 100_000_000;

/**
 * Normalise a v2 amount to a human unit for policy comparison.
 *
 * Returns the amount as a plain number plus a display symbol. Native HBAR
 * divides by 1e8; HTS tokens divide by their configured decimals, which the
 * caller must supply -- guessing wrong here is exactly the off-by-decimal
 * failure mode that slips past a ceiling (see docs/threat-model.md), so an
 * unknown token is a loud throw, never a guess.
 */
export function normaliseAmount(
  requirements: PaymentRequirements,
  htsDecimals?: Record<string, number>
): { amount: number; symbol: string } {
  if (requirements.asset === HBAR_ASSET_ID) {
    return { amount: Number(requirements.amount) / TINYBARS_PER_HBAR, symbol: "HBAR" };
  }
  const decimals = htsDecimals?.[requirements.asset] ?? DEFAULT_HTS_DECIMALS[requirements.asset];
  if (decimals !== undefined) {
    return {
      amount: Number(requirements.amount) / 10 ** decimals,
      symbol: requirements.asset,
    };
  }
  if (requirements.network.startsWith("eip155:")) {
    const evm = DEFAULT_EVM_DECIMALS[requirements.asset.toLowerCase()];
    if (evm !== undefined) {
      return {
        amount: Number(requirements.amount) / 10 ** evm,
        symbol: "USDC",
      };
    }
  }
  throw new Error(
    `cannot normalise amount for unknown asset ${requirements.asset} ` +
      `on ${requirements.network}: no decimals configured`
  );
}

/**
 * Build a stock `ClientHederaSigner` whose key stays sealed until sign time.
 *
 * Every signature unseals the ciphertext through the OS Key Ring (exactly one
 * `withSecret` call), delegates assembly + partial signing to the stock
 * `@x402/hedera` signer, and lets the derived key material drop out of scope
 * the moment the promise resolves. No key bytes are ever retained between
 * calls -- the returned signer only ever holds the ciphertext and the
 * account id, both safe to keep in memory.
 */
export function createSealedHederaSigner(
  ciphertext: Buffer,
  accountId: string
): ClientHederaSigner {
  return {
    accountId,
    createPartiallySignedTransferTransaction: (requirements: PaymentRequirements) =>
      withSecret("hedera-payment", ciphertext, async (keyBytes) => {
        const hex = keyBytes.toString("utf8").trim().replace(/^0x/, "");
        const delegate = createClientHederaSigner(
          accountId,
          PrivateKey.fromStringECDSA(hex),
          { network: requirements.network }
        );
        return delegate.createPartiallySignedTransferTransaction(requirements);
      }),
  };
}
