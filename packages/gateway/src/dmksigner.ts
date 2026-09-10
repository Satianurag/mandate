/**
 * M1 — the Ledger as an x402 signer.
 *
 * DmkEvmSigner implements x402's ClientEvmSigner with a Ledger behind
 * signTypedData: every call is a physical tap. x402's batch-settlement
 * client calls it exactly once per mandate (the EIP-3009 deposit
 * authorization); afterwards the hot session key signs vouchers, which can
 * only inflate toward the mandate's fixed receiver, capped by the deposit.
 * The device approves the mandate's bounds, never each micropayment.
 *
 * On-chain reads are deliberately NOT implemented: the device cannot do
 * RPC. Call sites compose reads via x402's own
 * toClientEvmSigner(signer, publicClient). Retries live in the caller too —
 * a signer that silently re-prompts would be a consent transpiler, not a
 * consent gate. Live proof: `npm run mandate:open` taps once, then streams.
 */

import type { ClientEvmSigner } from "@x402/evm";
import type {
  TypedData as DmkTypedData,
  Signature as DmkSignature,
  Address as DmkAddress,
} from "@ledgerhq/device-signer-kit-ethereum";
import { SignerEthBuilder } from "./ledger-cjs.ts";
import {
  awaitDeviceAction,
  getDmk,
  resetDmk,
  withDeviceSession,
} from "./dmk-session.ts";
import { formatLedgerError } from "./ledger-errors.ts";

export const DEFAULT_DERIVATION_PATH = "44'/60'/0'/0/0";

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
      skipOpenApp: opts.skipOpenApp ?? false,
      checkOnDevice: opts.checkOnDevice ?? false,
    };
    try {
      const address = await withDeviceSession(async (sessionId) => {
        const signer = new SignerEthBuilder({ dmk: getDmk(), sessionId }).build();
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
   * x402 passes — mandate bounds (receiver, token, max) under EIP-3009.
   */
  async signTypedData(message: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`> {
    this.signCalls++;
    try {
      const sig = await withDeviceSession(async (sessionId) => {
        const signer = new SignerEthBuilder({ dmk: getDmk(), sessionId }).build();
        const { observable } = signer.signTypedData(
          this.path,
          message as unknown as DmkTypedData,
          { skipOpenApp: this.skipOpenApp }
        );
        return awaitDeviceAction<DmkSignature>(observable, this.timeoutMs);
      }, this.timeoutMs);
      return joinSignature(sig);
    } catch (e) {
      throw new Error(`DmkEvmSigner.signTypedData: ${formatLedgerError(e)}`);
    } finally {
      resetDmk();
    }
  }
}
