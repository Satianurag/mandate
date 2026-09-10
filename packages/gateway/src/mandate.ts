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
import { toClientEvmSigner, type ChannelConfig, type ClientEvmSigner } from "@x402/evm";
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
import { caip2ForChainId } from "./chains.ts";

/** Envelope mandates settle on Base Sepolia. Hedera EVM 296 uses `openKeyRingMandate`. */
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

export interface KeyRingMandateConfig extends MandateConfig {
  /** Live `eth_chainId` — Base Sepolia or Hedera testnet EVM. */
  chainId: number;
  /** Already composed (`toClientEvmSigner`). Deposits + ERC-20 approval extensions. */
  payer: ClientEvmSigner;
  /**
   * Non-default assets (HTS USDC on `eip155:296` is not in x402 DEFAULT_ASSETS).
   * Stock spendControls allowlist — not a disabled safety rail.
   */
  allowedAssets: Array<{ network: string; asset: string; maxAmountPerPayment?: string }>;
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

function unsealSession(cfg: MandateConfig) {
  return unseal(cfg.sessionKeyName, cfg.sealedSessionKey);
}

async function assembleMandate(opts: {
  chainId: number;
  rpcUrl: string;
  payer: ClientEvmSigner;
  sessionBuf: Buffer;
  storageRoot: string;
  salt: `0x${string}`;
  strategy: ReturnType<typeof makeCeilingStrategy>;
  taps: () => number;
  allowedAssets?: Array<{ network: string; asset: string; maxAmountPerPayment?: string }>;
}): Promise<Mandate> {
  const network = caip2ForChainId(opts.chainId);
  const publicClient = createPublicClient({ transport: http(opts.rpcUrl) });
  const live = await publicClient.getChainId();
  if (live !== opts.chainId) {
    throw new Error(
      `RPC chain ${live} is not the mandate network (${opts.chainId}); refusing to sign.`
    );
  }
  if (opts.sessionBuf.length !== 32) {
    opts.sessionBuf.fill(0);
    throw new Error(`Session key unsealed to ${opts.sessionBuf.length} bytes, want 32.`);
  }
  const account = privateKeyToAccount(`0x${opts.sessionBuf.toString("hex")}`);
  const voucherSigner = toClientEvmSigner(account, publicClient);
  const storage = new FileClientChannelStorage({ directory: opts.storageRoot });
  const scheme = new BatchSettlementEvmScheme(opts.payer, {
    storage,
    voucherSigner,
    salt: opts.salt,
    depositStrategy: opts.strategy,
    rpcUrl: opts.rpcUrl,
  });
  const client = x402Client.fromConfig({
    schemes: [{ network, client: scheme }],
    ...(opts.allowedAssets?.length
      ? { spendControls: { allowedAssets: opts.allowedAssets } }
      : {}),
  });
  let closed = false;
  return {
    payer: opts.payer.address,
    session: account.address,
    fetch: wrapFetchWithPayment(globalThis.fetch, client),
    channelIdFor: (requirements: PaymentRequirements): `0x${string}` => {
      const config: ChannelConfig = scheme.buildChannelConfig(requirements);
      return computeChannelId(config, opts.chainId);
    },
    refund: (url: string) => scheme.refund(url),
    get taps() {
      return opts.taps();
    },
    close: () => {
      if (!closed) {
        closed = true;
        opts.sessionBuf.fill(0);
      }
    },
  };
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

  const sessionBuf = await unsealSession(cfg);
  try {
    return await assembleMandate({
      chainId,
      rpcUrl: cfg.rpcUrl,
      payer: toClientEvmSigner(device, publicClient),
      sessionBuf,
      storageRoot: cfg.storageRoot,
      salt: cfg.salt,
      strategy,
      taps: () => device.signCalls,
    });
  } catch (e) {
    sessionBuf.fill(0);
    throw e;
  }
}

/**
 * Same ceiling strategy and voucher session key as `openMandate`, but the
 * deposit signer is a Key Ring EOA (Hedera ECDSA). The Ledger is not a
 * Hedera account; using it here would fail Hashio `INVALID_ACCOUNT_ID`.
 */
export async function openKeyRingMandate(cfg: KeyRingMandateConfig): Promise<Mandate> {
  assertSalt(cfg.salt);
  const strategy = makeCeilingStrategy(cfg.ceilingBaseUnits);
  const sessionBuf = await unsealSession(cfg);
  try {
    return await assembleMandate({
      chainId: cfg.chainId,
      rpcUrl: cfg.rpcUrl,
      payer: cfg.payer,
      sessionBuf,
      storageRoot: cfg.storageRoot,
      salt: cfg.salt,
      strategy,
      taps: () => 0,
      allowedAssets: cfg.allowedAssets,
    });
  } catch (e) {
    sessionBuf.fill(0);
    throw e;
  }
}
