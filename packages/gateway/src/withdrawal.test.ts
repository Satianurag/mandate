import { test } from "node:test";
import assert from "node:assert/strict";
import { BATCH_SETTLEMENT_ADDRESS } from "@x402/evm";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import { privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData, getAddress, parseTransaction, type Hex } from "viem";
import { digest } from "./journal.ts";
import type { MandateFile } from "./mandate-config.ts";
import type { ChannelSnapshot } from "./reconciliation.ts";
import {
  applyLedgerTransactionSignature,
  assertFinalizationTransition,
  assertWithdrawalTransactionEnvelope,
  assertInitiationTransition,
  assertPreparedWithdrawalCurrent,
  assessWithdrawal,
  channelConfigFromMandate,
  encodeWithdrawalCall,
  ESCROW_WITHDRAWAL_ABI,
  serializeUnsignedWithdrawal,
  unsignedWithdrawalBytes,
  withdrawalStateFingerprint,
  type PreparedWithdrawalTransaction,
} from "./withdrawal.ts";

const cfg: MandateFile = {
  version: 2,
  network: "eip155:84532",
  rpcUrl: "https://sepolia.base.org",
  serviceUrl: "http://127.0.0.1:8405/analytics",
  ceilingBaseUnits: "100000",
  perCallBaseUnits: "10000",
  windowBaseUnits: "30000",
  windowMs: 3600000,
  salt: `0x${"11".repeat(32)}`,
  operatorAddress: "0x0000000000000000000000000000000000000001",
  receiver: "0x0000000000000000000000000000000000000003",
  asset: "0x0000000000000000000000000000000000000005",
  receiverAuthorizer: "0x0000000000000000000000000000000000000004",
  withdrawDelay: 900,
  expiresAt: "2027-01-01T00:00:00.000Z",
  sessionKey: "session",
  derivationPath: "44'/60'/0'/0/0",
  storageRoot: "state/test",
};
const config = channelConfigFromMandate(cfg, "0x0000000000000000000000000000000000000002");
const channelId = computeChannelId(config, 84532);
const snapshot = (overrides: Partial<ChannelSnapshot> = {}): ChannelSnapshot => ({
  network: "eip155:84532",
  blockNumber: "123",
  observedAt: "2026-09-11T00:00:00.000Z",
  channelId,
  balanceBaseUnits: "100000",
  claimedBaseUnits: "30000",
  payerBalanceBaseUnits: "0",
  receiverBalanceBaseUnits: "0",
  receiverAggregateClaimedBaseUnits: "30000",
  receiverAggregateSettledBaseUnits: "30000",
  withdrawalAmountBaseUnits: "0",
  withdrawalInitiatedAt: 0,
  refundNonce: "0",
  ...overrides,
});

test("exact installed x402 tuple ABI round-trips initiation and finalization", () => {
  const initiate = encodeWithdrawalCall("initiate", config, "70000");
  const decodedInitiate = decodeFunctionData({ abi: ESCROW_WITHDRAWAL_ABI, data: initiate });
  assert.equal(decodedInitiate.functionName, "initiateWithdraw");
  assert.equal(decodedInitiate.args[1], 70000n);
  assert.equal(computeChannelId(decodedInitiate.args[0], 84532), channelId);
  assert.equal(initiate.slice(0, 10), "0xcf5cf3dc");

  const finalize = encodeWithdrawalCall("finalize", config);
  const decodedFinalize = decodeFunctionData({ abi: ESCROW_WITHDRAWAL_ABI, data: finalize });
  assert.equal(decodedFinalize.functionName, "finalizeWithdraw");
  assert.equal(computeChannelId(decodedFinalize.args[0], 84532), channelId);
  assert.equal(finalize.slice(0, 10), "0xe88377b1");
});

test("withdrawal assessment fails closed until accepted liabilities are claimed and merchant revenue settled", () => {
  const unclaimed = assessWithdrawal(config, snapshot(), "35000", 1000);
  assert.equal(unclaimed.canPrepare, false);
  assert.match(unclaimed.reason ?? "", /not fully claimed/);
  const unsettled = assessWithdrawal(config, snapshot({ receiverAggregateSettledBaseUnits: "29999" }), "30000", 1000);
  assert.equal(unsettled.canPrepare, false);
  assert.match(unsettled.reason ?? "", /unsettled/);
  const ready = assessWithdrawal(config, snapshot(), "30000", 1000);
  assert.deepEqual({ kind: ready.kind, amount: ready.recoverableBaseUnits, canPrepare: ready.canPrepare }, { kind: "initiate", amount: "70000", canPrepare: true });
});

test("finalization readiness derives only from the on-chain initiation time and immutable delay", () => {
  const pending = snapshot({ withdrawalAmountBaseUnits: "70000", withdrawalInitiatedAt: 1000 });
  const early = assessWithdrawal(config, pending, "30000", 1500);
  assert.equal(early.kind, "finalize");
  assert.equal(early.readyAt, 1900);
  assert.equal(early.secondsUntilReady, 400);
  assert.equal(early.canPrepare, false);
  const ready = assessWithdrawal(config, pending, "30000", 1900);
  assert.equal(ready.canPrepare, true);
  assert.equal(ready.pendingBaseUnits, "70000");
});

test("unsigned EIP-1559 transaction is zero-value, exact-escrow, bounded, and Ledger signature is payer-verified", async () => {
  const account = privateKeyToAccount(`0x${"77".repeat(32)}`);
  const localCfg: MandateFile = { ...cfg, operatorAddress: account.address };
  const localConfig = channelConfigFromMandate(localCfg, "0x0000000000000000000000000000000000000002");
  const localChannelId = computeChannelId(localConfig, 84532);
  const encoded = serializeUnsignedWithdrawal({
    kind: "initiate",
    config: localConfig,
    channelId: localChannelId,
    amountBaseUnits: "70000",
    nonce: 9,
    gas: 120000n,
    maxFeePerGas: 1000000n,
    maxPriorityFeePerGas: 100000n,
  });
  const parsed = parseTransaction(encoded.unsignedSerialized);
  assert.equal(parsed.chainId, 84532);
  assert.equal(getAddress(parsed.to!), getAddress(BATCH_SETTLEMENT_ADDRESS));
  assert.equal(parsed.value ?? 0n, 0n);
  assert.equal(parsed.data, encoded.callData);
  assert.equal(unsignedWithdrawalBytes({ ...encoded, version: 1, kind: "initiate", network: "eip155:84532", chainId: 84532,
    channelId: localChannelId, contract: getAddress(BATCH_SETTLEMENT_ADDRESS), payer: account.address, token: localConfig.token,
    receiver: localConfig.receiver, withdrawDelay: 900, amountBaseUnits: "70000", nonce: 9, gas: "120000", maxFeePerGas: "1000000",
    maxPriorityFeePerGas: "100000", maxGasCostWei: "120000000000", payerNativeBalanceWei: "120000000001",
    preparedAt: "2026-09-11T00:00:00.000Z", sourceBlock: "123", stateFingerprint: "a", planHash: "b",
  } as PreparedWithdrawalTransaction).length > 0, true);

  const signedByAccount = await account.signTransaction(parsed);
  const signature = parseTransaction(signedByAccount);
  const applied = await applyLedgerTransactionSignature(encoded.unsignedSerialized, {
    r: signature.r as Hex,
    s: signature.s as Hex,
    v: signature.yParity!,
  }, account.address);
  assert.equal(applied.signedSerialized, signedByAccount);
  assert.equal(applied.signer, account.address);
  await assert.rejects(() => applyLedgerTransactionSignature(encoded.unsignedSerialized, {
    r: signature.r as Hex,
    s: signature.s as Hex,
    v: signature.yParity!,
  }, "0x0000000000000000000000000000000000000009"), /different payer/);
});


test("reviewed withdrawal plans invalidate on any channel, amount, nonce, or gas-funding change", () => {
  const encoded = serializeUnsignedWithdrawal({
    kind: "initiate",
    config,
    channelId,
    amountBaseUnits: "70000",
    nonce: 4,
    gas: 100000n,
    maxFeePerGas: 1000n,
    maxPriorityFeePerGas: 100n,
  });
  const base: Omit<PreparedWithdrawalTransaction, "planHash"> = {
    version: 1,
    kind: "initiate",
    network: "eip155:84532",
    chainId: 84532,
    channelId,
    contract: getAddress(BATCH_SETTLEMENT_ADDRESS),
    payer: config.payer,
    token: config.token,
    receiver: config.receiver,
    withdrawDelay: config.withdrawDelay,
    amountBaseUnits: "70000",
    callData: encoded.callData,
    selector: encoded.selector,
    nonce: 4,
    gas: "100000",
    maxFeePerGas: "1000",
    maxPriorityFeePerGas: "100",
    maxGasCostWei: "100000000",
    payerNativeBalanceWei: "100000001",
    unsignedSerialized: encoded.unsignedSerialized,
    unsignedHash: encoded.unsignedHash,
    preparedAt: "2026-09-11T00:00:00.000Z",
    sourceBlock: "123",
    stateFingerprint: withdrawalStateFingerprint(snapshot(), "30000"),
  };
  const plan: PreparedWithdrawalTransaction = { ...base, planHash: digest(base) };
  assert.equal(assertPreparedWithdrawalCurrent({
    plan,
    cfg,
    payerAuthorizer: config.payerAuthorizer,
    snapshot: snapshot(),
    liabilityBaseUnits: "30000",
    currentNonce: 4,
    currentNativeBalanceWei: 100000001n,
  }).kind, "initiate");
  assert.throws(() => assertPreparedWithdrawalCurrent({
    plan,
    cfg,
    payerAuthorizer: config.payerAuthorizer,
    snapshot: snapshot({ claimedBaseUnits: "30001" }),
    liabilityBaseUnits: "30000",
    currentNonce: 4,
    currentNativeBalanceWei: 100000001n,
  }), /not fully claimed|changed/);
  assert.throws(() => assertPreparedWithdrawalCurrent({
    plan,
    cfg,
    payerAuthorizer: config.payerAuthorizer,
    snapshot: snapshot(),
    liabilityBaseUnits: "30000",
    currentNonce: 5,
    currentNativeBalanceWei: 100000001n,
  }), /nonce changed/);
  assert.throws(() => assertPreparedWithdrawalCurrent({
    plan,
    cfg,
    payerAuthorizer: config.payerAuthorizer,
    snapshot: snapshot(),
    liabilityBaseUnits: "30000",
    currentNonce: 4,
    currentNativeBalanceWei: 99999999n,
  }), /enough Base Sepolia ETH/);
  assert.throws(() => assertPreparedWithdrawalCurrent({
    plan: { ...plan, amountBaseUnits: "69999" },
    cfg,
    payerAuthorizer: config.payerAuthorizer,
    snapshot: snapshot(),
    liabilityBaseUnits: "30000",
    currentNonce: 4,
    currentNativeBalanceWei: 100000001n,
  }), /plan hash is invalid/);
});

test("confirmed initiation and finalization transitions prove exact state changes", () => {
  const initiationPlan = { kind: "initiate", channelId, amountBaseUnits: "70000", withdrawDelay: 900 } as PreparedWithdrawalTransaction;
  const afterInitiation = snapshot({ withdrawalAmountBaseUnits: "70000", withdrawalInitiatedAt: 1000 });
  assert.deepEqual(assertInitiationTransition(initiationPlan, snapshot(), afterInitiation), { readyAt: 1900 });
  assert.throws(() => assertInitiationTransition(initiationPlan, snapshot(), { ...afterInitiation, payerBalanceBaseUnits: "1" }), /unexpectedly changed/);
  const finalPlan = { kind: "finalize", channelId, amountBaseUnits: "70000" } as PreparedWithdrawalTransaction;
  const afterFinal = snapshot({ balanceBaseUnits: "30000", payerBalanceBaseUnits: "70000", withdrawalAmountBaseUnits: "0", withdrawalInitiatedAt: 0 });
  assert.doesNotThrow(() => assertFinalizationTransition(finalPlan, afterInitiation, afterFinal));
  assert.throws(() => assertFinalizationTransition(finalPlan, afterInitiation, { ...afterFinal, payerBalanceBaseUnits: "69999" }), /return the reviewed amount/);
});


test("transaction-envelope verification rejects every change after review", () => {
  const encoded = serializeUnsignedWithdrawal({ kind: "initiate", config, channelId, amountBaseUnits: "70000", nonce: 4,
    gas: 100000n, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n });
  const base: Omit<PreparedWithdrawalTransaction, "planHash"> = {
    version: 1, kind: "initiate", network: "eip155:84532", chainId: 84532, channelId,
    contract: getAddress(BATCH_SETTLEMENT_ADDRESS), payer: config.payer, token: config.token, receiver: config.receiver,
    withdrawDelay: config.withdrawDelay, amountBaseUnits: "70000", callData: encoded.callData, selector: encoded.selector,
    nonce: 4, gas: "100000", maxFeePerGas: "1000", maxPriorityFeePerGas: "100", maxGasCostWei: "100000000",
    payerNativeBalanceWei: "100000001", unsignedSerialized: encoded.unsignedSerialized, unsignedHash: encoded.unsignedHash,
    preparedAt: "2026-09-11T00:00:00.000Z", sourceBlock: "123", stateFingerprint: withdrawalStateFingerprint(snapshot(), "30000"),
  };
  const plan: PreparedWithdrawalTransaction = { ...base, planHash: digest(base) };
  const transaction = { from: config.payer, to: getAddress(BATCH_SETTLEMENT_ADDRESS), value: 0n, input: plan.callData, nonce: 4, chainId: 84532 };
  assert.doesNotThrow(() => assertWithdrawalTransactionEnvelope(plan, transaction as never));
  assert.throws(() => assertWithdrawalTransactionEnvelope(plan, { ...transaction, from: "0x0000000000000000000000000000000000000009" } as never), /another payer/);
  assert.throws(() => assertWithdrawalTransactionEnvelope(plan, { ...transaction, to: "0x0000000000000000000000000000000000000009" } as never), /another contract/);
  assert.throws(() => assertWithdrawalTransactionEnvelope(plan, { ...transaction, value: 1n } as never), /native value/);
  assert.throws(() => assertWithdrawalTransactionEnvelope(plan, { ...transaction, input: "0x" } as never), /calldata differs/);
  assert.throws(() => assertWithdrawalTransactionEnvelope(plan, { ...transaction, nonce: 5 } as never), /nonce differs/);
  assert.throws(() => assertWithdrawalTransactionEnvelope(plan, { ...transaction, chainId: 1 } as never), /another chain/);
});
