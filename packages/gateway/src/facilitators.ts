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
 * INVARIANT: Never hardcode a fee payer. Two facilitators have advertised two
 * different payers for the same network (Blocky402 0.0.7162784 vs x402.org
 * 0.0.9185802 on exact@hedera:testnet, observed 2026-09-08). Always read it
 * from the live challenge's `extra` -- see docs/architecture.md.
 */

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
