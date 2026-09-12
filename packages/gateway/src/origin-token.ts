/**
 * Ledger Clear Signing origin token (partner program).
 *
 * Without this, CAL returns 403 and the Ethereum app falls back to legacy
 * EIP-712 / blind signing. Never log the token. Source: `LEDGER_ORIGIN_TOKEN`,
 * or Key Ring blob `secrets/ledger-origin.enc` (name `ledger-origin`).
 *
 * Docs: https://developers.ledger.com/docs/clear-signing/for-wallets
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withSecret } from "./keyring.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

export async function loadLedgerOriginToken(): Promise<string | undefined> {
  const fromEnv = process.env.LEDGER_ORIGIN_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const enc = await readFile(join(ROOT, "secrets/ledger-origin.enc"));
    const token = await withSecret("ledger-origin", enc, (b) =>
      Promise.resolve(b.toString("utf8").trim())
    );
    return token || undefined;
  } catch {
    return undefined;
  }
}

/** Funding and withdrawal signatures fail closed without a partner origin token. Address reads may omit it. */
export async function requireLedgerOriginToken(): Promise<string> {
  const token = await loadLedgerOriginToken();
  if (!token) {
    throw new Error(
      "Ledger funding requires LEDGER_ORIGIN_TOKEN or secrets/ledger-origin.enc. Without it CAL returns 403 and the device falls back to legacy signing."
    );
  }
  return token;
}

export function assertProductionClearSigning(report: {
  originTokenPresent: boolean;
  testCal?: boolean;
  verdict: ClearSigningVerdict;
}): void {
  if (!report.originTokenPresent && !report.testCal) {
    throw new Error("Ledger signature was produced without a partner origin token or the ledger-dev test CAL; the funding authorization was not submitted");
  }
  if (report.verdict !== "erc7730" && report.verdict !== "clear-basic") {
    throw new Error(`Ledger used ${report.verdict} instead of clear signing; the funding authorization was not submitted`);
  }
}

export function signerEthCtorArgs(
  dmk: unknown,
  sessionId: string,
  originToken: string | undefined
): { dmk: unknown; sessionId: string; originToken?: string } {
  const token = originToken?.trim();
  return token ? { dmk, sessionId, originToken: token } : { dmk, sessionId };
}

/**
 * DMK SignTypedData steps (see SignTypedDataDAStateStep).
 *
 * `DETECT_BLIND_SIGNING` runs after a successful clear sign too — it is a
 * reporter, not the screen the user saw. Legacy fallback is
 * `SIGN_TYPED_DATA_LEGACY` (`usedFallback: true` in the signer kit).
 */
export type ClearSigningVerdict = "erc7730" | "clear-basic" | "legacy-eip712" | "blind" | "unknown";
export type CalFilterStatus = "success" | "error" | "none";

const PROVIDE = /provideContext|provideGenericContext/i;
const LEGACY = /signTypedDataLegacy/i;
const CLEAR_SIGN = /steps\.signTypedData$/i;
const BLIND = /detectBlindSigning/i;

export function classifyTypedDataTrace(
  trace: Array<{ step?: string }>,
  calFilters: CalFilterStatus = "none"
): ClearSigningVerdict {
  const steps = trace.map((t) => t.step).filter((s): s is string => Boolean(s));
  const provided = steps.some((s) => PROVIDE.test(s));
  const legacy = steps.some((s) => LEGACY.test(s));
  const clearSign = steps.some((s) => CLEAR_SIGN.test(s));
  const blind = steps.some((s) => BLIND.test(s));
  if (legacy) return "legacy-eip712";
  // ERC-7730 labels require CAL filters (EIP712 filter Activation APDU).
  // provideContext+signTypedData without filters is BASIC structured EIP-712.
  if (provided && calFilters === "success") return "erc7730";
  if (provided || clearSign) return "clear-basic";
  if (blind && !provided) return "blind";
  return "unknown";
}

export function uniqueTraceSteps(trace: Array<{ step?: string }>): string[] {
  const out: string[] = [];
  for (const t of trace) {
    if (t.step && !out.includes(t.step)) out.push(t.step);
  }
  return out;
}
