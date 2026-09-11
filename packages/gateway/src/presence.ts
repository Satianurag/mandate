/**
 * Proof of You: device-signed human-presence bound to the operator UAID.
 *
 * Ledger does not ship a separate uniqueness-oracle SDK (F33). This module
 * is the documented surface: DMK getAddress(checkOnDevice) + an EIP-712
 * presence payload whose verifyingContract is the operator address itself
 * (no zero-address, no borrowed x402 contract).
 */

import { getAddress, verifyTypedData, type Hex } from "viem";

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
  const operator = process.env.MANDATE_OPERATOR_ADDRESS;
  const uaid = process.env.MANDATE_OPERATOR_UAID;
  if (!operator || !uaid) {
    throw new Error("Proof of You requires independently configured MANDATE_OPERATOR_ADDRESS and MANDATE_OPERATOR_UAID.");
  }
  const expected = { operator: getAddress(operator), uaid };
  await assertFreshPresence(attestation, expected);
  return { attestation, ...expected };
}

/**
 * Cryptographically verified recent presence. This is NOT one-time payment consent.
 * Identity and chain must come from trusted operator configuration, never the file.
 */
export async function assertFreshPresence(
  attestation: PresenceAttestation | null | undefined,
  expected: { operator: `0x${string}`; uaid: string; chainId?: number },
  now = Date.now()
): Promise<void> {
  if (!attestation) throw new Error("Proof of You required: no presence attestation.");
  const operator = getAddress(expected.operator);
  const c = attestation.challenge;
  if (!c?.message || !c.domain || !c.types) throw new Error("Proof of You: malformed challenge.");
  if (getAddress(attestation.address) !== operator || getAddress(c.message.operator) !== operator) {
    throw new Error("Proof of You: attestation address does not match operator.");
  }
  if (c.message.uaid !== expected.uaid) throw new Error("Proof of You: attestation UAID does not match operator UAID.");
  if (operator === "0x0000000000000000000000000000000000000000") {
    throw new Error("Proof of You: zero-address verifyingContract is banned.");
  }
  if (getAddress(c.domain.verifyingContract) !== operator) {
    throw new Error("Proof of You: verifyingContract must be the operator address.");
  }
  const age = now - c.message.issuedAt;
  if (!Number.isSafeInteger(c.message.issuedAt) || age < 0 || age > MAX_AGE_MS) {
    throw new Error("Proof of You: attestation expired or not yet valid.");
  }
  if (typeof c.message.nonce !== "string" || !c.message.nonce || c.message.nonce.length > 128) {
    throw new Error("Proof of You: malformed nonce.");
  }
  const canonical = buildPresenceChallenge({
    operator, uaid: expected.uaid, nonce: c.message.nonce,
    issuedAt: c.message.issuedAt, chainId: expected.chainId ?? 84532,
  });
  if (c.primaryType !== canonical.primaryType ||
      c.domain.name !== canonical.domain.name || c.domain.version !== canonical.domain.version ||
      c.domain.chainId !== canonical.domain.chainId ||
      JSON.stringify(c.types) !== JSON.stringify(canonical.types)) {
    throw new Error("Proof of You: non-canonical typed data or wrong chain.");
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(attestation.signature)) {
    throw new Error("Proof of You: malformed device signature.");
  }
  let valid = false;
  try {
    valid = await verifyTypedData({ ...canonical, address: operator, signature: attestation.signature });
  } catch { /* Invalid curve points and recovery IDs are rejection, not presence. */ }
  if (!valid) throw new Error("Proof of You: invalid device signature.");
}
