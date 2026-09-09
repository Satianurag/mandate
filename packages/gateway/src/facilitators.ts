/**
 * Facilitator addresses + a live support assertion. Nothing else.
 *
 * Supported-kind lists are deliberately NOT pinned here: what a facilitator
 * supports is a live fact, so both servers assert it at boot against the
 * facilitator's own `/supported` via the stock `HTTPFacilitatorClient`, and
 * the stock resource servers re-validate it in `initialize()`. A pinned
 * table would rot into a lie the day Blocky402 adds or drops a kind.
 *
 * Invariant 3 lives here too: never hardcode a fee payer. The Hedera
 * feePayer is merged from the live facilitator advertisement by the stock
 * scheme — read it from the live challenge, never from a constant.
 */

import { HTTPFacilitatorClient } from "@x402/core/http";

/** Blocky402 testnet facilitator base URL (trailing slash tolerated). */
export const BLOCKY402_URL = "https://api.testnet.blocky402.com";

/**
 * Base Sepolia USDC + chain facts, single-sourced for the mandate service.
 * Observed against the live chain; the service boot gate re-asserts the
 * deployment before serving.
 */
export const BASE_SEPOLIA = {
  chainId: 84532,
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
} as const;

/**
 * Assert the facilitator at `url` currently supports `kind`
 * (`"<scheme>@<network>"`, e.g. `"exact@hedera:testnet"`). Throws otherwise.
 */
export async function assertSupports(url: string, kind: string): Promise<void> {
  const client = new HTTPFacilitatorClient({ url });
  const supported = await client.getSupported();
  const kinds = supported.kinds.map((k) => `${k.scheme}@${k.network}`);
  if (!kinds.includes(kind)) {
    throw new Error(
      `${url} no longer advertises ${kind} (saw: ${kinds.join(", ") || "none"})`
    );
  }
}
