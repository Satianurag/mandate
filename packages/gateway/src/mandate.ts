/**
 * Testnet batch execution broker. Stock x402 supplies the channel and vouchers;
 * this layer pins the reviewed scope, reserves integer spend, persists outcomes,
 * and separates voucher acceptance from independently observed chain settlement.
 * Ledger signs the funding authorization, not the broker's URL/expiry/window rules.
 * Those application rules depend on the trusted broker and agent isolation.
 */

import { x402Client } from "@x402/core/client";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { toClientEvmSigner, type ChannelConfig, type ClientEvmSigner } from "@x402/evm";
import {
  BatchSettlementEvmScheme,
  computeChannelId,
  processPaymentResponse,
  type BatchSettlementDepositStrategy,
  type BatchSettlementDepositStrategyContext,
} from "@x402/evm/batch-settlement/client";
import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client/file-storage";
import { createPublicClient, http, verifyTypedData } from "viem";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { snapshotChannel, assertFundingSnapshot, assertRefundTransfers } from "./reconciliation.ts";
import { validateAnalyticsQuery } from "./query-scope.ts";
import { Journal, digest, units, type StoredResponse } from "./journal.ts";
import { validateScope, assertUnexpired, assertPaymentScope, assertRequestScope, type MandateScope } from "./scope.ts";
import { privateKeyToAccount } from "viem/accounts";
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
  /** Immutable broker scope; never inferred from an untrusted challenge. */
  scope: MandateScope;
  onDeviceState?: (state: "awaiting_signature" | "signature_verified") => void;
  expectedPayer?: `0x${string}`;
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
  allowedAssets: Array<{ network: Network; asset: string; maxAmountPerPayment?: string }>;
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
  reconcile: (requestId?: string) => Promise<unknown>;
  /** Device taps consumed — the demo asserts exactly 1. */
  readonly taps: number;
  /** Durable identifier and state for the operator workspace. */
  id: string;
  journal: Journal;
  stop: () => void;
  /** Invalidate all entry points and drop signer references; buffer wiping is best effort. */
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
  chainId: number; rpcUrl: string; payer: ClientEvmSigner; sessionBuf: Buffer;
  storageRoot: string; salt: `0x${string}`; strategy: ReturnType<typeof makeCeilingStrategy>;
  taps: () => number; scope: MandateScope; resumeOnly?: boolean;
  onDeviceState?: MandateConfig["onDeviceState"];
  signingReport?: () => unknown;
  allowedAssets?: Array<{ network: Network; asset: string; maxAmountPerPayment?: string }>;
}): Promise<Mandate> {
  const scope = validateScope(opts.scope);
  const network = caip2ForChainId(opts.chainId);
  if (scope.network !== network) throw new Error("Scope network differs from the signer network");
  const publicClient = createPublicClient({ transport: http(opts.rpcUrl, { timeout: 15_000, retryCount: 1 }) });
  if (await publicClient.getChainId() !== opts.chainId) throw new Error("RPC chain differs from the mandate; refusing to sign");
  if (opts.sessionBuf.length !== 32) throw new Error("Session key must be 32 bytes");
  let account: ReturnType<typeof privateKeyToAccount> | null = privateKeyToAccount(`0x${opts.sessionBuf.toString("hex")}`);
  const sessionAddress = account.address;
  const journal = new Journal(join(opts.storageRoot, "broker.sqlite"));
  const id = digest({ network, salt: opts.salt });
  let closed = false;
  let release: (() => void) | undefined;
  let serial: Promise<unknown> = Promise.resolve();
  const guard = (recovery = false) => {
    if (closed) throw new Error("Mandate client is closed; no further signing or requests are possible");
    if (!recovery) { journal.assertActive(id); assertUnexpired(scope); }
  };
  try {
    journal.register(id, { scope, salt: opts.salt });
    journal.bindIdentity(id, opts.payer.address, sessionAddress);
    release = journal.own(id);
    if (opts.resumeOnly && !journal.mandate(id)?.channel_id) throw new Error("Headless resume requires an existing pinned channel");
  } catch (e) { release?.(); journal.close(); account = null; throw e; }
  const storage = new FileClientChannelStorage({ directory: opts.storageRoot });
  const guardedPayer: ClientEvmSigner = {
    ...opts.payer,
    address: opts.payer.address,
    signTypedData: async (data) => {
      guard();
      if (opts.resumeOnly) throw new Error("Headless clients have no deposit signer; new funding requires Ledger authorization");
      opts.onDeviceState?.("awaiting_signature");
      const signature = await opts.payer.signTypedData(data);
      guard();
      const valid = await verifyTypedData({ ...data, address: opts.payer.address, signature } as Parameters<typeof verifyTypedData>[0]);
      if (!valid) throw new Error("Ledger returned a signature from a different principal");
      journal.event(id, null, "deposit.signature_verified", { payer: opts.payer.address, typedDataHash: digest(data), clearSigning: opts.signingReport?.() ?? null });
      opts.onDeviceState?.("signature_verified");
      return signature;
    },
  };
  let recovering = false;
  const voucherSigner = toClientEvmSigner({
    address: sessionAddress,
    signTypedData: async (data) => {
      guard(recovering);
      if (!account) throw new Error("Session signer is closed");
      return account.signTypedData(data as Parameters<typeof account.signTypedData>[0]);
    },
  }, publicClient);
  const makeScheme = () => new BatchSettlementEvmScheme(guardedPayer, {
    storage, voucherSigner, salt: opts.salt, rpcUrl: opts.rpcUrl,
    depositStrategy: (ctx) => {
      guard();
      if (opts.resumeOnly) throw new Error("Headless resume never deposits or tops up");
      assertPaymentScope(scope, ctx.paymentRequirements);
      const amount = opts.strategy(ctx);
      journal.depositOnce(id);
      return amount;
    },
  });
  const transport: typeof fetch = async (input, init) => {
    guard(recovering);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return fetch(input, { ...init, redirect: "error", signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  };
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = serial.then(fn); serial = result.catch(() => undefined); return result;
  };
  const paidFetch: typeof fetch = (input, init) => enqueue(async () => {
    guard();
    const url = assertRequestScope(scope, input, init);
    if (url.searchParams.has("q")) validateAnalyticsQuery(url.searchParams.get("q")!);
    if (journal.mandate(id)?.deposit === "pending") throw new Error("A prior deposit is unresolved; reconcile before another payment");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
    const requestId = headers.get("idempotency-key") ?? randomUUID();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new Error("Idempotency-Key must be 8-128 safe characters");
    headers.set("idempotency-key", requestId);
    const requestDigest = digest({ id, method: "GET", url: url.toString() });
    const prior = journal.request(requestId);
    if (prior) {
      if (prior.digest !== requestDigest || prior.mandate_id !== id) throw new Error("Idempotency key belongs to a different request");
      if (prior.response) {
        const r = JSON.parse(prior.response) as StoredResponse;
        return new Response(r.body, { status: r.status, headers: { ...r.headers, "x-mandate-replayed": "true" } });
      }
      throw new Error(`Request ${requestId} is ${prior.state}; reconcile before another payment`);
    }
    // A lost response can hide voucher liability. Do not let a fresh request race past it.
    if (journal.requests(id).some(r => ["reserved", "signed", "uncertain"].includes(r.state))) {
      throw new Error("An earlier request has an unresolved outcome; reconcile before new spending");
    }
    journal.event(id, requestId, "request.started", { method: "GET", url: url.toString(), digest: requestDigest });
    const scheme = makeScheme();
    const client = x402Client.fromConfig({
      schemes: [{ network, client: scheme }],
      spendControls: { allowedAssets: [{ network, asset: scope.asset, maxAmountPerPayment: scope.perCallBaseUnits }] },
    });
    client.onBeforePaymentCreation(async ctx => {
      guard();
      assertPaymentScope(scope, ctx.selectedRequirements);
      if (ctx.paymentRequired.resource?.url) assertRequestScope(scope, ctx.paymentRequired.resource.url);
      const channel = computeChannelId(scheme.buildChannelConfig(ctx.selectedRequirements), opts.chainId);
      journal.bindChannel(id, channel);
      journal.reserve({ id: requestId, mandateId: id, digest: requestDigest, network,
        asset: scope.asset, amount: ctx.selectedRequirements.amount, limits: scope });
    });
    client.onAfterPaymentCreation(async ctx => {
      guard();
      const payload = ctx.paymentPayload.payload as { type?: string; voucher?: { channelId?: string; maxClaimableAmount?: string } };
      if (!["deposit", "voucher"].includes(payload.type ?? "") ||
          payload.voucher?.channelId !== journal.mandate(id)?.channel_id ||
          units(payload.voucher?.maxClaimableAmount ?? "") > units(scope.ceilingBaseUnits)) throw new Error("SDK payload exceeds the pinned channel authority");
      const total = journal.totals(id, scope.windowMs);
      if (units(payload.voucher!.maxClaimableAmount!) !== units(total.spent) + units(total.reserved)) {
        throw new Error("Voucher cumulative liability does not match durable request accounting");
      }
      journal.signed(requestId, ctx.paymentPayload);
    });
    client.onPaymentResponse(async ctx => {
      if (ctx.settleResponse?.success) {
        const receipt = ctx.settleResponse;
        if (receipt.network !== network) throw new Error("Settlement receipt is for another network");
        const charged = (receipt.extra as { chargedAmount?: unknown } | undefined)?.chargedAmount;
        if (typeof charged !== "string" || charged !== ctx.requirements.amount) throw new Error("Batch receipt actual charge differs from the signed fixed-price liability; reconciliation required");
        const extra = receipt.extra as { channelState?: { chargedCumulativeAmount?: string } } | undefined;
        const total = journal.totals(id, scope.windowMs);
        if (units(extra?.channelState?.chargedCumulativeAmount ?? "") !== units(total.spent) + units(total.reserved)) throw new Error("Receipt cumulative charge differs from durable signed liability");
        journal.accept(requestId, charged, receipt);
        if (journal.mandate(id)?.deposit !== "funded") {
          const proof = await snapshotChannel({ rpcUrl: opts.rpcUrl, chainId: opts.chainId,
            channelId: journal.mandate(id)!.channel_id as `0x${string}`, asset: scope.asset,
            payer: opts.payer.address, receiver: scope.receiver });
          assertFundingSnapshot(proof, scope.ceilingBaseUnits);
          journal.funded(id, proof);
        }
      }
    });
    try {
      const result = await wrapFetchWithPayment(transport, client)(url, { ...init, method: "GET", headers, redirect: "error" });
      const body = await result.text();
      if (body.length > 2_000_000) throw new Error("Paid response exceeds the bounded result size");
      const response = { status: result.status, headers: Object.fromEntries(result.headers), body };
      response.headers["x-mandate-request-id"] = requestId;
      if (journal.request(requestId)) {
        if (journal.request(requestId)?.state !== "accepted") journal.fail(requestId, `HTTP ${result.status} did not establish a settlement`);
        journal.saveResponse(requestId, response);
      } else journal.event(id, requestId, "request.unpaid_response", { status: result.status });
      return new Response(body, { status: response.status, headers: response.headers });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      journal.fail(requestId, message);
      journal.event(id, requestId, "request.error", { message });
      throw e;
    }
  });
  return {
    id, journal, payer: opts.payer.address, session: sessionAddress, fetch: paidFetch,
    channelIdFor: requirements => {
      guard(); assertPaymentScope(scope, requirements);
      return computeChannelId(makeScheme().buildChannelConfig(requirements), opts.chainId);
    },
    refund: url => enqueue(async () => {
      guard(true); assertRequestScope(scope, url, undefined, true);
      const completed=journal.events(id).find(event=>event.kind==="refund.transaction_confirmed");
      if(journal.mandate(id)?.state==="refunded" && completed) {
        const proof=JSON.parse(completed.data);
        return {success:true,network,transaction:proof.transaction,refundedBaseUnits:proof.returnedBaseUnits,replayed:true};
      }
      const submitted=journal.events(id).find(event=>event.kind==="refund.transaction_submitted");
      if(submitted) {
        const pending=JSON.parse(submitted.data);
        const {confirmRefundTransaction}=await import("./reconciliation.ts");
        const proof=await confirmRefundTransaction({rpcUrl:opts.rpcUrl,chainId:opts.chainId,channelId:journal.mandate(id)!.channel_id as `0x${string}`,asset:scope.asset,payer:opts.payer.address,receiver:scope.receiver,transaction:pending.transaction,expectedBaseUnits:pending.expectedRefund,liabilityBaseUnits:journal.totals(id,scope.windowMs).spent});
        journal.refundConfirmed(id,proof);
        return {...pending.result,reconciled:true,newTransaction:false};
      }
      journal.stop(id); recovering = true;
      try {
        if (journal.requests(id).some(r => ["reserved", "signed", "uncertain"].includes(r.state))) throw new Error("Resolve uncertain voucher liabilities before requesting a refund");
        journal.event(id, null, "refund.requested", {});
        const scheme = makeScheme();
        const guardedRefundFetch: typeof fetch = async (input, init) => {
          const u = new URL(input instanceof Request ? input.url : String(input));
          const allowed = new URL(scope.serviceUrl);
          if (u.origin !== allowed.origin || u.pathname !== allowed.pathname) throw new Error("Refund redirected outside the mandate");
          const response = await transport(input, init);
          if (response.status === 402) {
            const { decodePaymentRequiredHeader } = await import("@x402/core/http");
            const offer = decodePaymentRequiredHeader(response.headers.get("payment-required") ?? "");
            const r = offer.accepts.find(r => r.scheme === "batch-settlement" && r.network === network);
            if (!r) throw new Error("Refund offer is missing the pinned scheme");
            // Expiry blocks purchases, not recovery. All financial identity checks still apply.
            assertPaymentScope(scope, r, Math.min(Date.now(), Date.parse(scope.expiresAt) - 1));
            const channel = computeChannelId(scheme.buildChannelConfig(r), opts.chainId);
            if (channel !== journal.mandate(id)?.channel_id) throw new Error("Refund channel differs from the pinned channel");
          }
          return response;
        };
        const channelId = journal.mandate(id)!.channel_id as `0x${string}`;
        const snapshotOpts = { rpcUrl: opts.rpcUrl, chainId: opts.chainId, channelId,
          asset: scope.asset, payer: opts.payer.address, receiver: scope.receiver };
        const before = await snapshotChannel(snapshotOpts);
        const liability = units(journal.totals(id, scope.windowMs).spent);
        if (units(before.claimedBaseUnits) > liability) throw new Error("On-chain claims exceed recorded liabilities; reconcile before refunding");
        const expectedRefund = units(before.balanceBaseUnits) - liability;
        if (expectedRefund <= 0n) throw new Error("No unspent escrow balance is available to refund");
        const result = await scheme.refund(url, { fetch: guardedRefundFetch, amount: String(expectedRefund) });
        if (!result.success || !/^0x[0-9a-fA-F]{64}$/.test(result.transaction)) throw new Error("Refund did not return a confirmable transaction");
        journal.event(id,null,"refund.transaction_submitted",{transaction:result.transaction,expectedRefund:String(expectedRefund),before,result});
        const receipt = await publicClient.waitForTransactionReceipt({ hash: result.transaction as `0x${string}`, timeout: 60_000 });
        const returned = assertRefundTransfers(receipt, { asset: scope.asset, payer: opts.payer.address, expectedBaseUnits: String(expectedRefund) });
        const after = await snapshotChannel({ ...snapshotOpts, blockNumber: receipt.blockNumber });
        if (units(before.balanceBaseUnits) - units(after.balanceBaseUnits) !== units(returned)) throw new Error("Refund transfer and channel balance do not reconcile");
        journal.refundConfirmed(id, { transaction: receipt.transactionHash, returnedBaseUnits: returned, before, after });
        return result;
      } catch (e) {
        journal.event(id, null, "refund.failed_or_uncertain", { message: e instanceof Error ? e.message : String(e) });
        throw e;
      } finally { recovering = false; }
    }),
    reconcile: requestId => enqueue(async () => {
      guard(true);
      const row = journal.mandate(id);
      if (!row?.channel_id) throw new Error("No pinned channel to reconcile");
      const snapshotOpts = {rpcUrl:opts.rpcUrl,chainId:opts.chainId,channelId:row.channel_id as `0x${string}`,asset:scope.asset,payer:opts.payer.address,receiver:scope.receiver};
      const snapshot = await snapshotChannel(snapshotOpts);
      if (!requestId) {
        if (row.deposit === "pending" && units(snapshot.balanceBaseUnits) === 0n) {
          journal.resetUnsignedDeposit(id);
          return {unsignedAttemptRecovered:true,newFundingAuthorized:false,snapshot};
        }
        if (row.deposit === "pending") { assertFundingSnapshot(snapshot,scope.ceilingBaseUnits); journal.funded(id,snapshot); }
        journal.event(id,null,"channel.reconciled",snapshot);
        return {snapshot,totals:journal.totals(id,scope.windowMs)};
      }
      const request = journal.request(requestId);
      if (!request || request.mandate_id !== id) throw new Error("Unknown request for this mandate");
      const signed = journal.db.prepare("SELECT data FROM events WHERE request_id=? AND kind='request.signed' ORDER BY seq DESC LIMIT 1").get(requestId) as {data:string}|undefined;
      const started = journal.db.prepare("SELECT data FROM events WHERE request_id=? AND kind='request.started' ORDER BY seq LIMIT 1").get(requestId) as {data:string}|undefined;
      if (!signed || !started) throw new Error("Original signed request evidence is unavailable; do not construct a replacement payment");
      const payload = JSON.parse(signed.data).payload;
      if (digest(payload) !== request.payload_hash) throw new Error("Signed request evidence failed its integrity check");
      const url = String(JSON.parse(started.data).url);
      assertRequestScope(scope,url,undefined,true);
      const {encodePaymentSignatureHeader,decodePaymentResponseHeader} = await import("@x402/core/http");
      const response = await fetch(url,{headers:{"payment-signature":encodePaymentSignatureHeader(payload),"x-mandate-reconcile":"1"},redirect:"error",signal:AbortSignal.timeout(15000)});
      if (!response.ok || response.headers.get("x-mandate-reconciled") !== "true") throw new Error("Merchant has not established the original outcome; reservation retained");
      const encoded = response.headers.get("payment-response");
      if (!encoded) throw new Error("Original receipt is missing; reservation retained");
      const receipt = decodePaymentResponseHeader(encoded);
      const extra = receipt.extra as {chargedAmount?:string;channelState?:{chargedCumulativeAmount?:string}}|undefined;
      const expected = String(payload.payload.voucher.maxClaimableAmount);
      if (!receipt.success || receipt.network !== network || extra?.chargedAmount !== request.maximum || extra?.channelState?.chargedCumulativeAmount !== expected) throw new Error("Original receipt does not match the signed fixed-price liability");
      const local = await storage.get(row.channel_id);
      const expectedBefore = units(expected)-units(request.maximum);
      if (local?.chargedCumulativeAmount !== expected && !(request.state === "accepted" && units(local?.chargedCumulativeAmount ?? "0") >= units(expected))) {
        if (units(local?.chargedCumulativeAmount ?? "0") !== expectedBefore) throw new Error("Client checkpoint requires independent reconciliation; do not advance it twice");
        await processPaymentResponse(storage,name=>response.headers.get(name),{channelId:row.channel_id as `0x${string}`,requestAmount:request.maximum,depositAmount:payload.payload.deposit?.amount});
      }
      if (row.deposit !== "funded") { assertFundingSnapshot(snapshot,scope.ceilingBaseUnits); journal.funded(id,snapshot); }
      journal.accept(requestId,request.maximum,receipt);
      const stored = {status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()};
      journal.saveResponse(requestId,stored);
      journal.event(id,requestId,"request.reconciled",{receipt,replayedFinancialOperation:false});
      return {requestId,receipt,result:JSON.parse(stored.body),newPayment:false,totals:journal.totals(id,scope.windowMs)};
    }),
    stop: () => { guard(true); journal.stop(id); },
    get taps() { return opts.taps(); },
    close: () => {
      if (closed) return;
      closed = true; account = null; opts.sessionBuf.fill(0);
      // Pending calls see `closed` before their next network or signing action.
      void serial.finally(() => { release?.(); journal.close(); }).catch(() => undefined);
    },
  };
}

export async function openMandate(cfg: MandateConfig): Promise<Mandate> {
  assertSalt(cfg.salt);
  validateScope(cfg.scope);
  if (cfg.scope.ceilingBaseUnits !== cfg.ceilingBaseUnits) throw new Error("Scope ceiling mismatch");
  const strategy = makeCeilingStrategy(cfg.ceilingBaseUnits);
  const publicClient = createPublicClient({ transport: http(cfg.rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== MANDATE_CHAIN_ID) {
    throw new Error(
      `RPC chain ${chainId} is not the mandate network (${MANDATE_CHAIN_ID}); refusing to sign.`
    );
  }

  const { DmkEvmSigner } = await import("./dmksigner.ts");
  const device = await DmkEvmSigner.create({
    path: cfg.derivationPath,
    timeoutMs: cfg.deviceTimeoutMs,
  });

  if (cfg.expectedPayer && device.address.toLowerCase() !== cfg.expectedPayer.toLowerCase()) throw new Error("Connected Ledger differs from the configured operator");
  const sessionBuf = await unsealSession(cfg);
  try {
    return await assembleMandate({
      chainId,
      scope: cfg.scope,
      rpcUrl: cfg.rpcUrl,
      payer: toClientEvmSigner(device, publicClient),
      sessionBuf,
      storageRoot: cfg.storageRoot,
      salt: cfg.salt,
      strategy,
      taps: () => device.signCalls,
      onDeviceState: cfg.onDeviceState,
      signingReport: () => device.lastClearSigning,
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
  validateScope(cfg.scope);
  if (cfg.scope.ceilingBaseUnits !== cfg.ceilingBaseUnits) throw new Error("Scope ceiling mismatch");
  const strategy = makeCeilingStrategy(cfg.ceilingBaseUnits);
  const sessionBuf = await unsealSession(cfg);
  try {
    return await assembleMandate({
      chainId: cfg.chainId,
      scope: cfg.scope,
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

/** Fresh-process resume: only the delegated session key is loaded; no HID or payer key. */
export async function resumeMandate(cfg: MandateConfig): Promise<Mandate> {
  assertSalt(cfg.salt); validateScope(cfg.scope);
  const journal = new Journal(join(cfg.storageRoot, "broker.sqlite"));
  const id = digest({ network: cfg.scope.network, salt: cfg.salt });
  const row = journal.mandate(id); journal.close();
  if (cfg.expectedPayer && row?.payer?.toLowerCase() !== cfg.expectedPayer.toLowerCase()) throw new Error("Journal payer differs from the configured operator");
  if (!row?.payer || !row.channel_id || row.deposit !== "funded") throw new Error("No journaled channel to resume; initialize with Ledger first");
  const payer: ClientEvmSigner = {
    address: row.payer as `0x${string}`,
    signTypedData: async () => { throw new Error("Headless payer cannot sign deposits"); },
  };
  const sessionBuf = await unsealSession(cfg);
  try {
    return await assembleMandate({ chainId: Number(cfg.scope.network.split(":")[1]),
      rpcUrl: cfg.rpcUrl, payer: toClientEvmSigner(payer, createPublicClient({ transport: http(cfg.rpcUrl) })),
      sessionBuf, storageRoot: cfg.storageRoot, salt: cfg.salt,
      scope: cfg.scope, strategy: makeCeilingStrategy(cfg.ceilingBaseUnits), resumeOnly: true, taps: () => 0 });
  } catch (e) { sessionBuf.fill(0); throw e; }
}
