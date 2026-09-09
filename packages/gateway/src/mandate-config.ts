/**
 * mandate.yaml — the mandate's durable identity.
 *
 * The file pins everything a mandate needs to resume after a restart: its
 * salt (channel id input), ceiling, receiver, and chain. It contains no
 * secrets — the session key lives sealed in the Key Ring and is named here.
 * Strict parse: unknown versions, missing fields, and malformed values throw
 * with the field name. Never defaults that could attach money to the wrong
 * channel.
 */

import { parse } from "yaml";
import { getAddress } from "viem";
import { MANDATE_NETWORK } from "./mandate.ts";

export interface MandateFile {
  version: 1;
  network: typeof MANDATE_NETWORK;
  rpcUrl: string;
  serviceUrl: string;
  ceilingBaseUnits: string;
  salt: `0x${string}`;
  receiver: `0x${string}`;
  sessionKey: string;
  derivationPath: string;
  storageRoot: string;
}

function fail(field: string, why: string): never {
  throw new Error(`mandate.yaml: field "${field}" ${why}.`);
}

export function parseMandateFile(text: string): MandateFile {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    throw new Error(`mandate.yaml: invalid YAML (${e instanceof Error ? e.message : e}).`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error("mandate.yaml: top level must be a mapping.");
  }
  const d = doc as Record<string, unknown>;
  if (d.version !== 1) fail("version", `must be 1, got ${JSON.stringify(d.version)}`);
  if (d.network !== MANDATE_NETWORK) {
    fail("network", `must be "${MANDATE_NETWORK}", got ${JSON.stringify(d.network)}`);
  }
  for (const f of ["rpcUrl", "serviceUrl", "sessionKey", "storageRoot"] as const) {
    if (typeof d[f] !== "string" || !(d[f] as string).trim()) fail(f, "must be a non-empty string");
  }
  for (const f of ["rpcUrl", "serviceUrl"] as const) {
    try {
      const u = new URL(d[f] as string);
      if (u.protocol !== "http:" && u.protocol !== "https:") fail(f, "must be http(s)");
    } catch {
      fail(f, `is not a URL: ${JSON.stringify(d[f])}`);
    }
  }
  if (typeof d.ceilingBaseUnits !== "string" || !/^\d+$/.test(d.ceilingBaseUnits)) {
    fail("ceilingBaseUnits", "must be a base-units integer string");
  }
  if (BigInt(d.ceilingBaseUnits as string) <= 0n) fail("ceilingBaseUnits", "must be positive");
  if (typeof d.salt !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(d.salt)) {
    fail("salt", "must be bytes32 hex");
  }
  let receiver: `0x${string}`;
  try {
    receiver = getAddress(d.receiver as string) as `0x${string}`;
  } catch {
    fail("receiver", `is not an address: ${JSON.stringify(d.receiver)}`);
  }
  if (d.derivationPath !== undefined && typeof d.derivationPath !== "string") {
    fail("derivationPath", "must be a string");
  }
  return {
    version: 1,
    network: MANDATE_NETWORK,
    rpcUrl: (d.rpcUrl as string).trim(),
    serviceUrl: (d.serviceUrl as string).trim(),
    ceilingBaseUnits: d.ceilingBaseUnits as string,
    salt: d.salt as `0x${string}`,
    receiver,
    sessionKey: (d.sessionKey as string).trim(),
    derivationPath: ((d.derivationPath as string) ?? "44'/60'/0'/0/0").trim(),
    storageRoot: (d.storageRoot as string).trim(),
  };
}
