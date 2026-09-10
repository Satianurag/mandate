/**
 * Proof of You: device-signed human-presence bound to the operator UAID.
 *
 * Ledger does not ship a separate uniqueness-oracle SDK (F33). This module
 * is the documented surface: DMK getAddress(checkOnDevice) + an EIP-712
 * presence payload whose verifyingContract is the operator address itself
 * (no zero-address, no borrowed x402 contract).
 */

import type { Hex } from "viem";

export const PRESENCE_PRIMARY_TYPE = "HumanPresence";

export interface PresenceChallenge {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: `0x${string}`;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: typeof PRESENCE_PRIMARY_TYPE;
  message: {
    operator: `0x${string}`;
    uaid: string;
    nonce: string;
    issuedAt: number;
  };
}

export interface PresenceAttestation {
  challenge: PresenceChallenge;
  signature: Hex;
  address: `0x${string}`;
}

export function buildPresenceChallenge(opts: {
  operator: `0x${string}`;
  uaid: string;
  nonce: string;
  issuedAt?: number;
  chainId?: number;
}): PresenceChallenge {
  const issuedAt = opts.issuedAt ?? Date.now();
  return {
    domain: {
      name: "Mandate Proof of You",
      version: "1",
      chainId: opts.chainId ?? 84532,
      verifyingContract: opts.operator,
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      HumanPresence: [
        { name: "operator", type: "address" },
        { name: "uaid", type: "string" },
        { name: "nonce", type: "string" },
        { name: "issuedAt", type: "uint256" },
      ],
    },
    primaryType: PRESENCE_PRIMARY_TYPE,
    message: {
      operator: opts.operator,
      uaid: opts.uaid,
      nonce: opts.nonce,
      issuedAt,
    },
  };
}

const MAX_AGE_MS = 15 * 60 * 1000;

/** Load a required Proof of You file when `MANDATE_REQUIRE_POH=1`. */
export async function loadRequiredPresence(): Promise<
  { attestation: PresenceAttestation; operator: `0x${string}`; uaid: string } | undefined
> {
  if (process.env.MANDATE_REQUIRE_POH !== "1") return undefined;
  const path = process.env.MANDATE_POH_ATTESTATION;
  if (!path) {
    throw new Error("MANDATE_REQUIRE_POH=1 requires MANDATE_POH_ATTESTATION (path to e2e:poh JSON).");
  }
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    attestation?: PresenceAttestation;
    challenge?: PresenceAttestation["challenge"];
    signature?: Hex;
    address?: `0x${string}`;
    operator?: `0x${string}`;
    uaid?: string;
  };
  const attestation: PresenceAttestation | null =
    raw.attestation ??
    (raw.challenge && raw.signature && raw.address
      ? { challenge: raw.challenge, signature: raw.signature, address: raw.address }
      : null);
  if (!attestation) {
    throw new Error("Proof of You file is missing attestation/challenge/signature.");
  }
  return {
    attestation,
    operator: (raw.operator ?? attestation.address) as `0x${string}`,
    uaid: raw.uaid ?? attestation.challenge.message.uaid,
  };
}

/** Freshness + binding checks. Replay of a missing/stale attestation fails. */
export function assertFreshPresence(
  attestation: PresenceAttestation | null | undefined,
  expected: { operator: `0x${string}`; uaid: string },
  now = Date.now()
): void {
  if (!attestation) {
    throw new Error("Proof of You required: no presence attestation.");
  }
  if (attestation.address.toLowerCase() !== expected.operator.toLowerCase()) {
    throw new Error("Proof of You: attestation address does not match operator.");
  }
  if (attestation.challenge.message.uaid !== expected.uaid) {
    throw new Error("Proof of You: attestation UAID does not match operator UAID.");
  }
  if (attestation.challenge.domain.verifyingContract.toLowerCase() !== expected.operator.toLowerCase()) {
    throw new Error("Proof of You: verifyingContract must be the operator address.");
  }
  if (attestation.challenge.domain.verifyingContract === "0x0000000000000000000000000000000000000000") {
    throw new Error("Proof of You: zero-address verifyingContract is banned.");
  }
  const age = now - attestation.challenge.message.issuedAt;
  if (age < 0 || age > MAX_AGE_MS) {
    throw new Error("Proof of You: attestation expired or not yet valid.");
  }
  if (!attestation.signature || attestation.signature.length < 132) {
    throw new Error("Proof of You: missing device signature.");
  }
}
