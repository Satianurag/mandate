/**
 * M2 — the mandate client.
 *
 * A mandate is one batch-settlement channel with policy teeth:
 *
 * - `ceilingBaseUnits` is the lifetime spend cap, deposited once, signed by
 *   the Ledger (one tap). The deposit strategy returns the ceiling on the
 *   empty channel and throws `MandateExhausted` on any top-up attempt —
 *   more spend means a new mandate (new salt), never a silent extension.
 * - Micropayments ride vouchers signed by the hot session key, which is
 *   committed into the channel config as `payerAuthorizer`. A voucher can
 *   only inflate `maxClaimableAmount` toward the mandate's fixed receiver,
 *   capped by the deposit: a leaked session key can neither redirect funds
 *   nor overspend the ceiling.
 * - Channel records persist in `FileClientChannelStorage` (`{root}/client/`),
 *   so vouchers survive process restarts. Corrective 402s resync from
 *   onchain state via the scheme's own hooks — no custom recovery code.
 *
 * Integration uses x402's own client (`x402Client` + `wrapFetchWithPayment`),
 * not hand-rolled headers: `processPaymentResult` is what advances the
 * local channel state from PAYMENT-RESPONSE. Bypassing it would fork the
 * vouchers from the chain. Live proof: `npm run mandate:open`.
 */

import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { toClientEvmSigner, type ChannelConfig } from "@x402/evm";
import {
  BatchSettlementEvmScheme,
  computeChannelId,
  type BatchSettlementDepositStrategy,
  type BatchSettlementDepositStrategyContext,
} from "@x402/evm/batch-settlement/client";
import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client/file-storage";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DmkEvmSigner } from "./dmksigner.ts";
import { unseal } from "./keyring.ts";

/** Mandates settle on Base Sepolia. No other chain has been tested. */
export const MANDATE_CHAIN_ID = 84532;
export const MANDATE_NETWORK = "eip155:84532";

export class MandateExhausted extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "MandateExhausted";
  }
}

export interface MandateConfig {
  rpcUrl: string;
  /** Channel records root (`{root}/client/*.json`). Must survive restarts. */
  storageRoot: string;
  /** Key Ring key name sealing the 32-byte voucher session key. */
  sessionKeyName: string;
  sealedSessionKey: Buffer;
  /** Lifetime spend cap in token base units (e.g. "5000000" = $5 USDC). */
  ceilingBaseUnits: string;
  /** Fresh bytes32 per mandate — the channel id commits it. */
  salt: `0x${string}`;
  derivationPath?: string;
  deviceTimeoutMs?: number;
}

export interface Mandate {
  /** The payer (device address). */
  payer: `0x${string}`;
  /** The session key address (channel payerAuthorizer). */
  session: `0x${string}`;
  /** fetch() with the 402 → pay → retry loop built in. */
  fetch: typeof fetch;
  /** Channel id for a set of requirements (resolves the mandate's channel). */
  channelIdFor: (requirements: PaymentRequirements) => `0x${string}`;
  /** Cooperative refund of the unspent deposit. */
  refund: (url: string) => Promise<unknown>;
  /** Device taps consumed — the demo asserts exactly 1. */
  readonly taps: number;
  /** Wipe the session key from memory. */
  close: () => void;
}

/**
 * The ceiling as a deposit strategy: fund the full mandate on the empty
 * channel, refuse everything else. Pure — pinned by unit tests; the scheme
 * calls it only when a deposit is actually attempted.
 */
export function makeCeilingStrategy(
  ceilingBaseUnits: string
): BatchSettlementDepositStrategy {
  if (!/^\d+$/.test(ceilingBaseUnits) || BigInt(ceilingBaseUnits) <= 0n) {
    throw new Error(`Invalid mandate ceiling: ${JSON.stringify(ceilingBaseUnits)}.`);
  }
  return (ctx: BatchSettlementDepositStrategyContext) => {
    if (ctx.currentBalance !== "0") {
      throw new MandateExhausted(
        `mandate ceiling ${ceilingBaseUnits} exhausted ` +
          `(balance ${ctx.currentBalance}, requested ${ctx.requestAmount}); ` +
          `open a new mandate for more spend`
      );
    }
    if (BigInt(ctx.requestAmount) > BigInt(ceilingBaseUnits)) {
      throw new MandateExhausted(
        `single request ${ctx.requestAmount} exceeds mandate ceiling ${ceilingBaseUnits}`
      );
    }
    return ceilingBaseUnits;
  };
}

function assertSalt(salt: string): asserts salt is `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) {
    throw new Error(`Mandate salt must be bytes32, got ${JSON.stringify(salt)}.`);
  }
}

export async function openMandate(cfg: MandateConfig): Promise<Mandate> {
  assertSalt(cfg.salt);
  const strategy = makeCeilingStrategy(cfg.ceilingBaseUnits);

  const publicClient = createPublicClient({ transport: http(cfg.rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== MANDATE_CHAIN_ID) {
    throw new Error(
      `RPC chain ${chainId} is not the mandate network (${MANDATE_CHAIN_ID}); refusing to sign.`
    );
  }

  const device = await DmkEvmSigner.create({
    path: cfg.derivationPath,
    timeoutMs: cfg.deviceTimeoutMs,
  });

  // Session key: unsealed once, held for the mandate's lifetime, wiped on
  // close. viem needs it as hex, so V8 string copies exist until GC — the
  // same caveat keyring.withSecret documents; the wipe covers our Buffer.
  const sessionBuf = await unseal(cfg.sessionKeyName, cfg.sealedSessionKey);
  if (sessionBuf.length !== 32) {
    sessionBuf.fill(0);
    throw new Error(
      `Session key ${cfg.sessionKeyName} unsealed to ${sessionBuf.length} bytes, want 32.`
    );
  }
  const account = privateKeyToAccount(`0x${sessionBuf.toString("hex")}`);

  const signer = toClientEvmSigner(device, publicClient);
  const voucherSigner = toClientEvmSigner(account, publicClient);
  const storage = new FileClientChannelStorage({ directory: cfg.storageRoot });
  const scheme = new BatchSettlementEvmScheme(signer, {
    storage,
    voucherSigner,
    salt: cfg.salt,
    depositStrategy: strategy,
  });
  const client = x402Client.fromConfig({
    schemes: [{ network: MANDATE_NETWORK, client: scheme }],
  });

  let closed = false;
  return {
    payer: device.address,
    session: account.address,
    fetch: wrapFetchWithPayment(globalThis.fetch, client),
    channelIdFor: (requirements: PaymentRequirements): `0x${string}` => {
      const config: ChannelConfig = scheme.buildChannelConfig(requirements);
      return computeChannelId(config, MANDATE_CHAIN_ID);
    },
    refund: (url: string) => scheme.refund(url),
    get taps() {
      return device.signCalls;
    },
    close: () => {
      if (!closed) {
        closed = true;
        sessionBuf.fill(0);
      }
    },
  };
}
