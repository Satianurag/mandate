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

/**
 * Base mainnet USDC + chain facts, single-sourced for the mandate service.
 * Observed against the live chain; the service boot gate re-asserts the
 * deployment before serving.
 */
export const BASE_MAINNET = {
  chainId: 8453,
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
} as const;

/** Loopback self-hosted facilitator started by `scripts/start.mjs` when secrets exist. */
export const DEFAULT_FACILITATOR_URL = "http://127.0.0.1:8406" as const;

/** Circle Hedera mainnet USDC HTS id. Confirmed live via mainnet mirror as USD Coin / 6 decimals. */
export const CIRCLE_HEDERA_MAINNET_USDC_HTS = "0.0.456858" as const;

/**
 * Assert the facilitator at `url` currently supports `kind`
 * (`"<scheme>@<network>"`, e.g. `"exact@hedera:mainnet"`). Throws otherwise.
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
