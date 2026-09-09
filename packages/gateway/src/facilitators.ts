/**
 * Facilitator registry.
 *
 * Every value here was read from a live `/supported` response on 2026-09-08,
 * not from documentation. Re-run `npm run preflight` before the demo: fee
 * payers and supported kinds change without notice, and a stale one produces a
 * confusing "invalid transaction" rather than a clean error.
 */

export interface FacilitatorConfig {
  name: string;
  baseUrl: string;
  /** Schemes and CAIP-2 networks observed live. */
  supports: string[];
}

/**
 * Hedera's ETHOnline track explicitly requires Blocky402, so the Hedera-side
 * service uses this one. Testnet is open access -- no API key.
 */
export const BLOCKY402_TESTNET: FacilitatorConfig = {
  name: "blocky402-testnet",
  baseUrl: "https://api.testnet.blocky402.com",
  supports: ["exact@eip155:80002", "exact@hedera:testnet", "exact@solana:devnet"],
};

/**
 * The x402 Foundation facilitator. This is the ONLY public facilitator observed
 * to support `batch-settlement`, and it does so on Base Sepolia -- which makes
 * the entire mandate-envelope demo possible on testnet, with no real money.
 *
 * It also supports exact@hedera:testnet, with a DIFFERENT fee payer from
 * Blocky402 (0.0.9185802 vs 0.0.7162784).
 *
 * INVARIANT: Never hardcode a fee payer.
 * Always read it from the live challenge's `extra` -- see docs/architecture.md.
 */
export const X402_FOUNDATION: FacilitatorConfig = {
  name: "x402-foundation",
  baseUrl: "https://x402.org/facilitator",
  supports: [
    "batch-settlement@eip155:84532",
    "upto@eip155:84532",
    "exact@eip155:84532",
    "exact@hedera:testnet",
  ],
};

/** Base Sepolia — where the mandate escrow channel lives. Testnet, free. */
export const BASE_SEPOLIA = {
  caip2: "eip155:84532",
  chainId: 84532,
  rpc: "https://sepolia.base.org",
  /** Circle's testnet USDC. totalSupply confirmed non-zero on 2026-09-08. */
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
} as const;

export const HEDERA_TESTNET = {
  caip2: "hedera:testnet",
  chainId: 296,
  /** Hiero JSON-RPC relay. eth_chainId returned 0x128 on 2026-09-08. */
  jsonRpc: "https://testnet.hashio.io/api",
  mirrorNode: "https://testnet.mirrornode.hedera.com/api/v1",
} as const;

/** Confirm a facilitator still advertises what we depend on. */
export async function assertSupports(
  cfg: FacilitatorConfig,
  required: string
): Promise<void> {
  const res = await fetch(`${cfg.baseUrl}/supported`);
  if (!res.ok) throw new Error(`${cfg.name}: /supported returned ${res.status}`);
  const body = (await res.json()) as {
    kinds?: { scheme?: string; network?: string }[];
  };
  const live = (body.kinds ?? []).map((k) => `${k.scheme}@${k.network}`);
  if (!live.includes(required)) {
    throw new Error(
      `${cfg.name} no longer advertises ${required}. Live kinds: ${live.join(", ")}`
    );
  }
}
