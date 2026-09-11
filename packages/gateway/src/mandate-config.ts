/** Versioned immutable operator authority. Legacy v1 is never silently widened. */
import { parse } from "yaml";
import { getAddress } from "viem";
import { validateScope, type MandateScope } from "./scope.ts";
import { units } from "./journal.ts";
export interface MandateFile extends MandateScope {
  version: 2;
  network: "eip155:84532";
  rpcUrl: string;
  salt: `0x${string}`;
  operatorAddress: `0x${string}`;
  sessionKey: string;
  derivationPath: string;
  storageRoot: string;
}
function fail(field: string, why: string): never { throw new Error(`mandate.yaml: field "${field}" ${why}.`); }
export function parseMandateFile(text: string): MandateFile {
  let value: unknown;
  try { value = parse(text); } catch { throw new Error("mandate.yaml: invalid YAML."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mandate.yaml: top level must be a mapping.");
  const d = value as Record<string, unknown>;
  if (d.version === 1) fail("version", "is legacy v1: review a new v2 scope in the operator workspace; the original configuration and funded channel must be preserved for recovery");
  if (d.version !== 2) fail("version", "must be 2");
  const allowed = new Set(["version","network","rpcUrl","serviceUrl","ceilingBaseUnits","perCallBaseUnits","windowBaseUnits","windowMs","salt","receiver","asset","receiverAuthorizer","withdrawDelay","expiresAt","operatorAddress","sessionKey","derivationPath","storageRoot"]);
  for (const k of Object.keys(d)) if (!allowed.has(k)) fail(k, "is not a recognized authority field");
  if (d.network !== "eip155:84532") fail("network", "must be eip155:84532 for the Ledger operator workspace");
  for (const f of ["rpcUrl","serviceUrl","sessionKey","storageRoot","expiresAt"] as const) {
    if (typeof d[f] !== "string" || !(d[f] as string).trim()) fail(f, "must be a non-empty string");
  }
  const rpc = new URL(String(d.rpcUrl));
  if (rpc.username || rpc.password || !(rpc.protocol === "https:" || (rpc.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(rpc.hostname)))) fail("rpcUrl", "must be HTTPS or loopback HTTP without credentials");
  for (const f of ["ceilingBaseUnits","perCallBaseUnits","windowBaseUnits"] as const) {
    try { units(d[f] as string, true); } catch { fail(f, "must be a positive integer base-units string"); }
  }
  if (typeof d.salt !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(d.salt) || /^0x0+$/.test(d.salt)) fail("salt", "must be fresh, nonzero bytes32 hex");
  for (const f of ["operatorAddress","receiver","asset","receiverAuthorizer"] as const) {
    try { d[f] = getAddress(d[f] as string); } catch { fail(f, "must be a checksummed EVM address"); }
    if (d[f] === "0x0000000000000000000000000000000000000000") fail(f, "cannot be zero");
  }
  if (d.operatorAddress === d.receiver) fail("receiver", "must differ from the payer");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(d.sessionKey))) fail("sessionKey", "must be a safe Key Ring name");
  if (d.derivationPath !== undefined && (typeof d.derivationPath !== "string" || !/^44'\/60'\/[0-9]+'\/[0-9]+\/[0-9]+$/.test(d.derivationPath))) fail("derivationPath", "must be an Ethereum BIP-44 path");
  const result = { ...d, derivationPath: d.derivationPath ?? "44'/60'/0'/0/0" } as unknown as MandateFile;
  return { ...result, ...validateScope(scopeOf(result)), network: "eip155:84532" };
}
export function scopeOf(m: MandateFile): MandateScope {
  return { network: m.network, serviceUrl: m.serviceUrl, asset: m.asset, receiver: m.receiver,
    receiverAuthorizer: m.receiverAuthorizer, withdrawDelay: m.withdrawDelay, expiresAt: m.expiresAt,
    ceilingBaseUnits: m.ceilingBaseUnits, perCallBaseUnits: m.perCallBaseUnits,
    windowBaseUnits: m.windowBaseUnits, windowMs: m.windowMs };
}
