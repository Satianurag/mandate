import { assertTestnetChain } from "./testnet.ts";
/**
 * Ledger DMK adapter for testnet EIP-712 signing. Every signing call uses the
 * physical device and verifies its network before requesting a signature.
 * The report distinguishes CAL/ERC-7730, clear-basic, legacy and unknown paths.
 * Funding binds stock channel authority cryptographically; URL, rolling budget,
 * and task expiry are broker rules, not device-screen or contract guarantees.
 */

import type { ClientEvmSigner } from "@x402/evm";
import type {
  TypedData as DmkTypedData,
  Signature as DmkSignature,
  Address as DmkAddress,
} from "@ledgerhq/device-signer-kit-ethereum";
import { SignerEthBuilder, ContextModuleBuilder, ContextModuleChainID } from "./ledger-cjs.ts";
import {
  awaitDeviceAction,
  getDmk,
  resetDmk,
  withDeviceSession,
  type DeviceActionTrace,
} from "./dmk-session.ts";
import { formatLedgerError } from "./ledger-errors.ts";
import {
  classifyTypedDataTrace,
  loadLedgerOriginToken,
  uniqueTraceSteps,
  type CalFilterStatus,
  type ClearSigningVerdict,
} from "./origin-token.ts";
import type { ContextModule } from "@ledgerhq/context-module";

export const DEFAULT_DERIVATION_PATH = "44'/60'/0'/0/0";

export interface ClearSigningReport {
  originTokenPresent: boolean;
  verdict: ClearSigningVerdict;
  steps: string[];
  calFilters: CalFilterStatus;
}

/** Build the Ethereum signer with partner originToken when available. Never log the token. */
export async function buildEthSigner(sessionId: string) {
  const originToken = await loadLedgerOriginToken();
  const cal = { typedDataFilters: "none" as CalFilterStatus };
  const inner = new ContextModuleBuilder({
    originToken: originToken ?? "",
    loggerFactory: (tag) => getDmk().getLoggerFactory()(["ContextModule", tag]),
  })
    .setChain(ContextModuleChainID.Ethereum)
    .build();
  const contextModule: ContextModule = {
    getContexts: (input, types) => inner.getContexts(input, types),
    getFieldContext: (field, expectedType) => inner.getFieldContext(field, expectedType),
    report: (params) => inner.report(params),
    signReport: inner.signReport ? (params) => inner.signReport!(params) : undefined,
    async getTypedDataFilters(typedData) {
      const result = await inner.getTypedDataFilters(typedData);
      cal.typedDataFilters = result.type === "success" ? "success" : "error";
      return result;
    },
  };
  const signer = new SignerEthBuilder({
    dmk: getDmk(),
    sessionId,
  })
    .withContextModule(contextModule)
    .build();
  return { signer, originTokenPresent: Boolean(originToken), cal };
}

export interface DmkSignerOptions {
  path?: string;
  /** Per-action device wait (discovery + tap). No silent retries. */
  timeoutMs?: number;
  skipOpenApp?: boolean;
  /** Proof of You / address-verify. Mandate open keeps this false (one tap is the EIP-3009). */
  checkOnDevice?: boolean;
}

/** Join DMK's {r, s, v} into the 65-byte 0x signature x402 expects. */
export function joinSignature(sig: DmkSignature): `0x${string}` {
  const hex = (h: string, bytes: number) =>
    h.replace(/^0x/, "").padStart(bytes * 2, "0");
  // DMK often returns the recovery id (0/1). Circle FiatToken permit()
  // requires v ∈ {27, 28}; Permit2 is more lenient. Normalize once here.
  let v = Number(sig.v);
  if (v < 27) v += 27;
  return `0x${hex(sig.r, 32)}${hex(sig.s, 32)}${hex(v.toString(16), 1)}`;
}

export class DmkEvmSigner implements ClientEvmSigner {
  readonly address: `0x${string}`;
  /** Device taps consumed. The mandate demo asserts this stays at 1. */
  public signCalls = 0;
  /** Last EIP-712 tap: CAL/ERC-7730 vs legacy vs unknown. */
  public lastClearSigning: ClearSigningReport | null = null;
  private readonly path: string;
  private readonly timeoutMs: number;
  private readonly skipOpenApp: boolean;

  private constructor(
    address: `0x${string}`,
    opts: Required<DmkSignerOptions>
  ) {
    this.address = address;
    this.path = opts.path;
    this.timeoutMs = opts.timeoutMs;
    this.skipOpenApp = opts.skipOpenApp;
  }

  /**
   * Resolve the address for `path` from the device (read-only, no tap),
   * then return a signer bound to it. Throws when no device answers.
   */
  static async create(opts: DmkSignerOptions = {}): Promise<DmkEvmSigner> {
    const full = {
      path: opts.path ?? DEFAULT_DERIVATION_PATH,
      timeoutMs: opts.timeoutMs ?? 120_000,
      skipOpenApp: opts.skipOpenApp ?? process.env.MANDATE_ETH_APP_OPEN === "1",
      checkOnDevice: opts.checkOnDevice ?? false,
    };
    try {
      const address = await withDeviceSession(async (sessionId) => {
        const { signer } = await buildEthSigner(sessionId);
        const { observable } = signer.getAddress(full.path, {
          checkOnDevice: full.checkOnDevice,
          skipOpenApp: full.skipOpenApp,
        });
        const out = await awaitDeviceAction<DmkAddress>(observable, full.timeoutMs);
        return out.address;
      }, full.timeoutMs);
      return new DmkEvmSigner(address as `0x${string}`, full);
    } catch (e) {
      throw new Error(`DmkEvmSigner.create: ${formatLedgerError(e)}`);
    } finally {
      resetDmk();
    }
  }

  /**
   * One device tap per call. The typed data shown on screen is exactly what
   * x402 passes — the stock EIP-3009 authorization. Inspect the recorded signing report;
   * do not infer on-device human-readable scope labels from application text.
   */
  async signTypedData(message: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`> {
    assertTestnetChain(message.domain.chainId);
    this.signCalls++;
    const trace: DeviceActionTrace[] = [];
    try {
      const sig = await withDeviceSession(async (sessionId) => {
        const { signer, originTokenPresent, cal } = await buildEthSigner(sessionId);
        try {
          const { observable } = signer.signTypedData(
            this.path,
            message as unknown as DmkTypedData,
            { skipOpenApp: this.skipOpenApp }
          );
          return await awaitDeviceAction<DmkSignature>(observable, this.timeoutMs, trace);
        } finally {
          const steps = uniqueTraceSteps(trace);
          const calFilters = cal.typedDataFilters;
          const verdict = classifyTypedDataTrace(trace, calFilters);
          this.lastClearSigning = { originTokenPresent, verdict, steps, calFilters };
          console.error(
            `>>> Ledger EIP-712 originToken=${originTokenPresent ? "yes" : "no"} calFilters=${calFilters} verdict=${verdict} steps=${steps.join(",") || "none"}`
          );
        }
      }, this.timeoutMs);
      return joinSignature(sig);
    } catch (e) {
      throw new Error(`DmkEvmSigner.signTypedData: ${formatLedgerError(e)}`);
    } finally {
      resetDmk();
    }
  }
}
