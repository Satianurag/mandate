/**
 * Two-stage payer withdrawal for x402 batch-settlement.
 *
 * This module deliberately separates call construction, read-only RPC preparation,
 * Ledger signing, broadcasting, and confirmation. Importing it never talks to a
 * device or a network.
 */
import { BATCH_SETTLEMENT_ADDRESS, type ChannelConfig } from "@x402/evm";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  http,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionReceipt,
  type TransactionSerializableEIP1559,
} from "viem";
import { assertMainnetChain } from "./mainnet.ts";
import { digest } from "./journal.ts";
import type { MandateFile } from "./mandate-config.ts";
import { assertRefundTransfers, snapshotChannel, type ChannelSnapshot } from "./reconciliation.ts";

export const BASE_SEPOLIA_CHAIN_ID = 8453;
export const CHANNEL_CONFIG_TUPLE = "(address payer,address payerAuthorizer,address receiver,address receiverAuthorizer,address token,uint40 withdrawDelay,bytes32 salt)";
export const ESCROW_WITHDRAWAL_ABI = parseAbi([
  `function initiateWithdraw(${CHANNEL_CONFIG_TUPLE} config,uint128 amount)`,
  `function finalizeWithdraw(${CHANNEL_CONFIG_TUPLE} config)`,
  "function channels(bytes32 channelId) view returns (uint128 balance,uint128 totalClaimed)",
  "function pendingWithdrawals(bytes32 channelId) view returns (uint128 amount,uint40 initiatedAt)",
]);

export type WithdrawalKind = "initiate" | "finalize";

export interface WithdrawalAssessment {
  kind: WithdrawalKind;
  channelId: Hex;
  recoverableBaseUnits: string;
  pendingBaseUnits: string;
  initiatedAt: number;
  readyAt: number | null;
  secondsUntilReady: number;
  canPrepare: boolean;
  reason: string | null;
}

export interface PreparedWithdrawalTransaction {
  version: 1;
  kind: WithdrawalKind;
  network: "eip155:8453";
  chainId: 8453;
  channelId: Hex;
  contract: Address;
  payer: Address;
  token: Address;
  receiver: Address;
  withdrawDelay: number;
  amountBaseUnits: string;
  callData: Hex;
  selector: Hex;
  nonce: number;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  maxGasCostWei: string;
  payerNativeBalanceWei: string;
  unsignedSerialized: Hex;
  unsignedHash: Hex;
  preparedAt: string;
  sourceBlock: string;
  stateFingerprint: string;
  planHash: string;
}

export interface LedgerTransactionSignature {
  r: Hex;
  s: Hex;
  v: number;
}

export function channelConfigFromMandate(cfg: MandateFile, payerAuthorizer: string): ChannelConfig {
  if (!/^0x[0-9a-fA-F]{40}$/.test(payerAuthorizer)) throw new Error("Pinned payer authorizer is missing or invalid");
  const config: ChannelConfig = {
    payer: getAddress(cfg.operatorAddress),
    payerAuthorizer: getAddress(payerAuthorizer),
    receiver: getAddress(cfg.receiver),
    receiverAuthorizer: getAddress(cfg.receiverAuthorizer),
    token: getAddress(cfg.asset),
    withdrawDelay: cfg.withdrawDelay,
    salt: cfg.salt,
  };
  if (!Number.isSafeInteger(config.withdrawDelay) || config.withdrawDelay < 900 || config.withdrawDelay > 2_592_000) {
    throw new Error("Withdrawal delay must remain within the x402 contract range of 15 minutes to 30 days");
  }
  return Object.freeze(config);
}

export function assessWithdrawal(
  config: ChannelConfig,
  snapshot: ChannelSnapshot,
  liabilityBaseUnits: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): WithdrawalAssessment {
  assertMainnetChain(BASE_SEPOLIA_CHAIN_ID);
  const channelId = computeChannelId(config, BASE_SEPOLIA_CHAIN_ID);
  if (snapshot.network !== "eip155:8453") throw new Error("Withdrawal snapshot is from another network");
  if (snapshot.channelId.toLowerCase() !== channelId.toLowerCase()) throw new Error("Withdrawal snapshot is for another channel");
  const balance = BigInt(snapshot.balanceBaseUnits);
  const claimed = BigInt(snapshot.claimedBaseUnits);
  const liability = BigInt(liabilityBaseUnits);
  const pending = BigInt(snapshot.withdrawalAmountBaseUnits);
  if (claimed > balance) throw new Error("Invalid channel accounting: claimed exceeds balance");
  if (liability !== claimed) {
    return {
      kind: pending > 0n ? "finalize" : "initiate",
      channelId,
      recoverableBaseUnits: String(balance - claimed),
      pendingBaseUnits: String(pending),
      initiatedAt: snapshot.withdrawalInitiatedAt,
      readyAt: pending > 0n ? snapshot.withdrawalInitiatedAt + config.withdrawDelay : null,
      secondsUntilReady: 0,
      canPrepare: false,
      reason: "Accepted payment liability is not fully claimed on-chain; settle it before timed withdrawal",
    };
  }
  if (BigInt(snapshot.receiverAggregateClaimedBaseUnits) !== BigInt(snapshot.receiverAggregateSettledBaseUnits)) {
    return {
      kind: pending > 0n ? "finalize" : "initiate",
      channelId,
      recoverableBaseUnits: String(balance - claimed),
      pendingBaseUnits: String(pending),
      initiatedAt: snapshot.withdrawalInitiatedAt,
      readyAt: pending > 0n ? snapshot.withdrawalInitiatedAt + config.withdrawDelay : null,
      secondsUntilReady: 0,
      canPrepare: false,
      reason: "Merchant aggregate revenue remains unsettled",
    };
  }
  if (pending === 0n) {
    const recoverable = balance - claimed;
    return {
      kind: "initiate",
      channelId,
      recoverableBaseUnits: String(recoverable),
      pendingBaseUnits: "0",
      initiatedAt: 0,
      readyAt: null,
      secondsUntilReady: 0,
      canPrepare: recoverable > 0n,
      reason: recoverable > 0n ? null : "No unclaimed escrow balance remains to withdraw",
    };
  }
  if (snapshot.withdrawalInitiatedAt <= 0) throw new Error("Pending withdrawal amount has no initiation timestamp");
  const readyAt = snapshot.withdrawalInitiatedAt + config.withdrawDelay;
  const secondsUntilReady = Math.max(0, readyAt - nowSeconds);
  return {
    kind: "finalize",
    channelId,
    recoverableBaseUnits: String(balance - claimed),
    pendingBaseUnits: String(pending),
    initiatedAt: snapshot.withdrawalInitiatedAt,
    readyAt,
    secondsUntilReady,
    canPrepare: secondsUntilReady === 0,
    reason: secondsUntilReady === 0 ? null : `Withdrawal delay has ${secondsUntilReady} seconds remaining`,
  };
}

export function withdrawalStateFingerprint(snapshot: ChannelSnapshot, liabilityBaseUnits: string): string {
  return digest({
    channelId: snapshot.channelId.toLowerCase(),
    balance: snapshot.balanceBaseUnits,
    claimed: snapshot.claimedBaseUnits,
    receiverClaimed: snapshot.receiverAggregateClaimedBaseUnits,
    receiverSettled: snapshot.receiverAggregateSettledBaseUnits,
    pending: snapshot.withdrawalAmountBaseUnits,
    initiatedAt: snapshot.withdrawalInitiatedAt,
    liability: liabilityBaseUnits,
  });
}

export function assertInitiationTransition(
  plan: PreparedWithdrawalTransaction,
  before: ChannelSnapshot,
  after: ChannelSnapshot,
): { readyAt: number } {
  if (plan.kind !== "initiate") throw new Error("Expected an initiation plan");
  if (before.channelId.toLowerCase() !== plan.channelId.toLowerCase() || after.channelId.toLowerCase() !== plan.channelId.toLowerCase()) throw new Error("Initiation confirmation is for another channel");
  if (BigInt(before.withdrawalAmountBaseUnits) !== 0n || BigInt(after.withdrawalAmountBaseUnits) !== BigInt(plan.amountBaseUnits)) throw new Error("Initiation did not establish the reviewed pending amount");
  if (after.withdrawalInitiatedAt <= 0) throw new Error("Initiation did not establish an on-chain timestamp");
  if (before.balanceBaseUnits !== after.balanceBaseUnits || before.claimedBaseUnits !== after.claimedBaseUnits || before.payerBalanceBaseUnits !== after.payerBalanceBaseUnits) throw new Error("Initiation unexpectedly changed token balances or channel accounting");
  if (after.receiverAggregateClaimedBaseUnits !== after.receiverAggregateSettledBaseUnits) throw new Error("Merchant revenue remains unsettled after initiation");
  return { readyAt: after.withdrawalInitiatedAt + plan.withdrawDelay };
}

export function assertFinalizationTransition(
  plan: PreparedWithdrawalTransaction,
  before: ChannelSnapshot,
  after: ChannelSnapshot,
): void {
  if (plan.kind !== "finalize") throw new Error("Expected a finalization plan");
  const amount = BigInt(plan.amountBaseUnits);
  if (before.channelId.toLowerCase() !== plan.channelId.toLowerCase() || after.channelId.toLowerCase() !== plan.channelId.toLowerCase()) throw new Error("Finalization confirmation is for another channel");
  if (BigInt(before.withdrawalAmountBaseUnits) !== amount || BigInt(after.withdrawalAmountBaseUnits) !== 0n) throw new Error("Finalization did not clear the reviewed pending withdrawal");
  if (BigInt(before.balanceBaseUnits) - BigInt(after.balanceBaseUnits) !== amount || BigInt(after.payerBalanceBaseUnits) - BigInt(before.payerBalanceBaseUnits) !== amount) throw new Error("Finalization did not return the reviewed amount to the payer");
  if (before.claimedBaseUnits !== after.claimedBaseUnits || after.balanceBaseUnits !== after.claimedBaseUnits) throw new Error("Finalization did not leave exactly accepted liability in escrow");
  if (after.receiverAggregateClaimedBaseUnits !== after.receiverAggregateSettledBaseUnits) throw new Error("Merchant revenue remains unsettled after finalization");
}

export function encodeWithdrawalCall(kind: WithdrawalKind, config: ChannelConfig, amountBaseUnits?: string): Hex {
  if (kind === "initiate") {
    if (amountBaseUnits === undefined || !/^[1-9][0-9]*$/.test(amountBaseUnits)) throw new Error("Initiation requires a positive base-unit amount");
    const amount = BigInt(amountBaseUnits);
    if (amount >= 2n ** 128n) throw new Error("Withdrawal amount exceeds uint128");
    return encodeFunctionData({ abi: ESCROW_WITHDRAWAL_ABI, functionName: "initiateWithdraw", args: [config, amount] });
  }
  if (amountBaseUnits !== undefined) throw new Error("Finalization does not accept an amount");
  return encodeFunctionData({ abi: ESCROW_WITHDRAWAL_ABI, functionName: "finalizeWithdraw", args: [config] });
}

export function assertWithdrawalCall(
  data: Hex,
  expected: { kind: WithdrawalKind; config: ChannelConfig; channelId: Hex; amountBaseUnits: string },
): void {
  const decoded = decodeFunctionData({ abi: ESCROW_WITHDRAWAL_ABI, data });
  if (decoded.functionName !== (expected.kind === "initiate" ? "initiateWithdraw" : "finalizeWithdraw")) throw new Error("Withdrawal calldata calls the wrong function");
  const decodedConfig = decoded.args[0] as ChannelConfig;
  const decodedChannelId = computeChannelId(decodedConfig, BASE_SEPOLIA_CHAIN_ID);
  if (decodedChannelId.toLowerCase() !== expected.channelId.toLowerCase()) throw new Error("Withdrawal calldata identifies another channel");
  for (const field of ["payer", "payerAuthorizer", "receiver", "receiverAuthorizer", "token"] as const) {
    if (getAddress(decodedConfig[field]) !== getAddress(expected.config[field])) throw new Error(`Withdrawal calldata changes channel ${field}`);
  }
  if (decodedConfig.withdrawDelay !== expected.config.withdrawDelay || decodedConfig.salt.toLowerCase() !== expected.config.salt.toLowerCase()) {
    throw new Error("Withdrawal calldata changes immutable channel configuration");
  }
  if (expected.kind === "initiate" && decoded.args[1] !== BigInt(expected.amountBaseUnits)) throw new Error("Withdrawal calldata changes the reviewed amount");
}

export function serializeUnsignedWithdrawal(input: {
  kind: WithdrawalKind;
  config: ChannelConfig;
  channelId: Hex;
  amountBaseUnits: string;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}): { callData: Hex; unsignedSerialized: Hex; unsignedHash: Hex; selector: Hex } {
  if (!Number.isSafeInteger(input.nonce) || input.nonce < 0) throw new Error("Withdrawal nonce must be a non-negative safe integer");
  if (input.gas <= 0n || input.gas > 5_000_000n) throw new Error("Withdrawal gas limit is outside the product safety bound");
  if (input.maxPriorityFeePerGas < 0n || input.maxFeePerGas <= 0n || input.maxPriorityFeePerGas > input.maxFeePerGas) throw new Error("Invalid EIP-1559 fee fields");
  const callData = encodeWithdrawalCall(input.kind, input.config, input.kind === "initiate" ? input.amountBaseUnits : undefined);
  assertWithdrawalCall(callData, input);
  const transaction: TransactionSerializableEIP1559 = {
    type: "eip1559",
    chainId: BASE_SEPOLIA_CHAIN_ID,
    nonce: input.nonce,
    gas: input.gas,
    maxFeePerGas: input.maxFeePerGas,
    maxPriorityFeePerGas: input.maxPriorityFeePerGas,
    to: BATCH_SETTLEMENT_ADDRESS,
    value: 0n,
    data: callData,
  };
  const unsignedSerialized = serializeTransaction(transaction);
  const parsed = parseTransaction(unsignedSerialized);
  if (parsed.type !== "eip1559" || parsed.chainId !== BASE_SEPOLIA_CHAIN_ID || !parsed.to || getAddress(parsed.to) !== getAddress(BATCH_SETTLEMENT_ADDRESS) || (parsed.value ?? 0n) !== 0n || parsed.data !== callData) {
    throw new Error("Unsigned withdrawal transaction failed its serialization round trip");
  }
  return { callData, unsignedSerialized, unsignedHash: keccak256(unsignedSerialized), selector: callData.slice(0, 10) as Hex };
}

export async function applyLedgerTransactionSignature(
  unsignedSerialized: Hex,
  signature: LedgerTransactionSignature,
  expectedSigner: Address,
): Promise<{ signedSerialized: Hex; transactionHash: Hex; signer: Address }> {
  const parsed = parseTransaction(unsignedSerialized);
  if (parsed.r !== undefined || parsed.s !== undefined || parsed.yParity !== undefined) throw new Error("Expected an unsigned transaction");
  const v = Number(signature.v);
  const yParity = (v === 27 || v === 28 ? v - 27 : v) as 0 | 1;
  if (yParity !== 0 && yParity !== 1) throw new Error("Ledger returned an invalid EIP-1559 recovery value");
  if (!/^0x[0-9a-fA-F]{64}$/.test(signature.r) || !/^0x[0-9a-fA-F]{64}$/.test(signature.s)) throw new Error("Ledger returned malformed transaction signature fields");
  const signedSerialized = serializeTransaction(parsed as TransactionSerializableEIP1559, { r: signature.r, s: signature.s, yParity });
  const signer = getAddress(await recoverTransactionAddress({ serializedTransaction: signedSerialized }));
  if (signer !== getAddress(expectedSigner)) throw new Error("Ledger transaction signature belongs to a different payer");
  return { signedSerialized, transactionHash: keccak256(signedSerialized), signer };
}

export function assertPreparedWithdrawalCurrent(input: {
  plan: PreparedWithdrawalTransaction;
  cfg: MandateFile;
  payerAuthorizer: string;
  snapshot: ChannelSnapshot;
  liabilityBaseUnits: string;
  currentNonce: number;
  currentNativeBalanceWei: bigint;
  nowSeconds?: number;
}): WithdrawalAssessment {
  const { plan } = input;
  const { planHash, ...withoutHash } = plan;
  if (digest(withoutHash) !== planHash) throw new Error("Stored withdrawal plan hash is invalid");
  if (plan.network !== "eip155:8453" || plan.chainId !== BASE_SEPOLIA_CHAIN_ID || getAddress(plan.contract) !== getAddress(BATCH_SETTLEMENT_ADDRESS)) throw new Error("Stored withdrawal plan is not Base mainnet x402 escrow");
  const config = channelConfigFromMandate(input.cfg, input.payerAuthorizer);
  const channelId = computeChannelId(config, BASE_SEPOLIA_CHAIN_ID);
  if (channelId.toLowerCase() !== plan.channelId.toLowerCase()) throw new Error("Stored withdrawal plan no longer matches the immutable channel");
  const assessment = assessWithdrawal(config, input.snapshot, input.liabilityBaseUnits, input.nowSeconds);
  if (!assessment.canPrepare || assessment.kind !== plan.kind) throw new Error(assessment.reason ?? "Withdrawal state changed after review");
  const amount = assessment.kind === "initiate" ? assessment.recoverableBaseUnits : assessment.pendingBaseUnits;
  if (amount !== plan.amountBaseUnits) throw new Error("Withdrawal amount changed after review");
  if (withdrawalStateFingerprint(input.snapshot, input.liabilityBaseUnits) !== plan.stateFingerprint) throw new Error("Withdrawal channel state changed after review");
  if (input.currentNonce !== plan.nonce) throw new Error("Payer transaction nonce changed after review");
  if (input.currentNativeBalanceWei < BigInt(plan.maxGasCostWei)) throw new Error("Payer no longer has enough Base mainnet ETH for the reviewed maximum gas cost");
  const parsed = parseTransaction(plan.unsignedSerialized);
  if (parsed.type !== "eip1559" || parsed.chainId !== BASE_SEPOLIA_CHAIN_ID || !parsed.to || getAddress(parsed.to) !== getAddress(BATCH_SETTLEMENT_ADDRESS) || (parsed.value ?? 0n) !== 0n || parsed.data !== plan.callData || parsed.nonce !== plan.nonce) throw new Error("Stored unsigned transaction differs from the reviewed withdrawal plan");
  assertWithdrawalCall(plan.callData, { kind: plan.kind, config, channelId: plan.channelId, amountBaseUnits: plan.amountBaseUnits });
  return assessment;
}

export interface WithdrawalTransactionEnvelope {
  from: Address;
  to: Address | null;
  value: bigint;
  input: Hex;
  nonce: number;
  chainId: number;
}

export function assertWithdrawalTransactionEnvelope(
  plan: PreparedWithdrawalTransaction,
  transaction: WithdrawalTransactionEnvelope,
): void {
  if (transaction.chainId !== BASE_SEPOLIA_CHAIN_ID) throw new Error("Withdrawal transaction is on another chain");
  if (getAddress(transaction.from) !== getAddress(plan.payer)) throw new Error("Withdrawal transaction was signed by another payer");
  if (!transaction.to || getAddress(transaction.to) !== getAddress(BATCH_SETTLEMENT_ADDRESS)) throw new Error("Withdrawal transaction targets another contract");
  if (transaction.value !== 0n) throw new Error("Withdrawal transaction unexpectedly transfers native value");
  if (transaction.input !== plan.callData) throw new Error("Withdrawal transaction calldata differs from the reviewed plan");
  if (transaction.nonce !== plan.nonce) throw new Error("Withdrawal transaction nonce differs from the reviewed plan");
}

export async function readPreparedWithdrawalCurrent(input: {
  plan: PreparedWithdrawalTransaction;
  cfg: MandateFile;
  payerAuthorizer: string;
  liabilityBaseUnits: string;
  nowSeconds?: number;
}): Promise<{ assessment: WithdrawalAssessment; snapshot: ChannelSnapshot; currentNonce: number; currentNativeBalanceWei: bigint }> {
  const publicClient = createPublicClient({ transport: http(input.cfg.rpcUrl, { timeout: 15_000, retryCount: 1 }) });
  if (await publicClient.getChainId() !== BASE_SEPOLIA_CHAIN_ID) throw new Error("Withdrawal RPC is not Base mainnet");
  const [snapshot, currentNonce, currentNativeBalanceWei] = await Promise.all([
    snapshotChannel({
      rpcUrl: input.cfg.rpcUrl,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      channelId: input.plan.channelId,
      asset: input.cfg.asset,
      payer: input.cfg.operatorAddress,
      receiver: input.cfg.receiver,
    }),
    publicClient.getTransactionCount({ address: getAddress(input.cfg.operatorAddress), blockTag: "pending" }),
    publicClient.getBalance({ address: getAddress(input.cfg.operatorAddress), blockTag: "pending" }),
  ]);
  const assessment = assertPreparedWithdrawalCurrent({
    ...input,
    snapshot,
    currentNonce,
    currentNativeBalanceWei,
  });
  return { assessment, snapshot, currentNonce, currentNativeBalanceWei };
}

export type ConfirmedWithdrawal =
  | { kind: "initiate"; transaction: Hex; amountBaseUnits: string; readyAt: number; before: ChannelSnapshot; after: ChannelSnapshot; network: "eip155:8453" }
  | { kind: "finalize"; transaction: Hex; returnedBaseUnits: string; before: ChannelSnapshot; after: ChannelSnapshot; network: "eip155:8453" };

export async function confirmWithdrawalTransaction(input: {
  cfg: MandateFile;
  plan: PreparedWithdrawalTransaction;
  transactionHash: Hex;
}): Promise<ConfirmedWithdrawal> {
  assertMainnetChain(BASE_SEPOLIA_CHAIN_ID);
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash)) throw new Error("Withdrawal transaction hash is malformed");
  const publicClient = createPublicClient({ transport: http(input.cfg.rpcUrl, { timeout: 15_000, retryCount: 1 }) });
  if (await publicClient.getChainId() !== BASE_SEPOLIA_CHAIN_ID) throw new Error("Withdrawal confirmation RPC is not Base mainnet");
  const [transaction, receipt] = await Promise.all([
    publicClient.getTransaction({ hash: input.transactionHash }),
    publicClient.getTransactionReceipt({ hash: input.transactionHash }),
  ]);
  if (receipt.status !== "success") throw new Error("Withdrawal transaction reverted");
  if (receipt.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase()) throw new Error("Withdrawal receipt is for another transaction");
  assertWithdrawalTransactionEnvelope(input.plan, {
    from: getAddress(transaction.from),
    to: transaction.to ? getAddress(transaction.to) : null,
    value: transaction.value,
    input: transaction.input,
    nonce: transaction.nonce,
    chainId: transaction.chainId ?? 0,
  });
  if (receipt.blockNumber === 0n) throw new Error("Withdrawal confirmation block has no prior state snapshot");
  const common = {
    rpcUrl: input.cfg.rpcUrl,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    channelId: input.plan.channelId,
    asset: input.cfg.asset,
    payer: input.cfg.operatorAddress,
    receiver: input.cfg.receiver,
  };
  const [before, after] = await Promise.all([
    snapshotChannel({ ...common, blockNumber: receipt.blockNumber - 1n }),
    snapshotChannel({ ...common, blockNumber: receipt.blockNumber }),
  ]);
  if (input.plan.kind === "initiate") {
    const { readyAt } = assertInitiationTransition(input.plan, before, after);
    return { kind: "initiate", transaction: input.transactionHash, amountBaseUnits: input.plan.amountBaseUnits, readyAt, before, after, network: "eip155:8453" };
  }
  assertFinalizationTransition(input.plan, before, after);
  assertRefundTransfers(receipt as Pick<TransactionReceipt, "status" | "logs" | "transactionHash">, {
    asset: input.cfg.asset,
    payer: input.cfg.operatorAddress,
    expectedBaseUnits: input.plan.amountBaseUnits,
  });
  return { kind: "finalize", transaction: input.transactionHash, returnedBaseUnits: input.plan.amountBaseUnits, before, after, network: "eip155:8453" };
}

export async function broadcastSignedWithdrawal(input: {
  cfg: MandateFile;
  plan: PreparedWithdrawalTransaction;
  signedSerialized: Hex;
  expectedTransactionHash: Hex;
}): Promise<ConfirmedWithdrawal> {
  const signer = getAddress(await recoverTransactionAddress({ serializedTransaction: input.signedSerialized as `0x02${string}` }));
  if (signer !== getAddress(input.plan.payer)) throw new Error("Signed withdrawal belongs to another payer");
  if (keccak256(input.signedSerialized).toLowerCase() !== input.expectedTransactionHash.toLowerCase()) throw new Error("Signed withdrawal hash changed after Ledger review");
  const parsed = parseTransaction(input.signedSerialized);
  assertWithdrawalTransactionEnvelope(input.plan, {
    from: signer,
    to: parsed.to ? getAddress(parsed.to) : null,
    value: parsed.value ?? 0n,
    input: parsed.data ?? "0x",
    nonce: parsed.nonce ?? 0,
    chainId: parsed.chainId ?? 0,
  });
  const publicClient = createPublicClient({ transport: http(input.cfg.rpcUrl, { timeout: 15_000, retryCount: 1 }) });
  if (await publicClient.getChainId() !== BASE_SEPOLIA_CHAIN_ID) throw new Error("Withdrawal broadcast RPC is not Base mainnet");
  const returnedHash = await publicClient.sendRawTransaction({ serializedTransaction: input.signedSerialized as `0x02${string}` });
  if (returnedHash.toLowerCase() !== input.expectedTransactionHash.toLowerCase()) throw new Error("RPC returned a different withdrawal transaction hash");
  await publicClient.waitForTransactionReceipt({ hash: returnedHash, timeout: 120_000, confirmations: 1 });
  return confirmWithdrawalTransaction({ cfg: input.cfg, plan: input.plan, transactionHash: returnedHash });
}

export async function prepareWithdrawalTransaction(input: {
  cfg: MandateFile;
  payerAuthorizer: string;
  snapshot: ChannelSnapshot;
  liabilityBaseUnits: string;
  nowSeconds?: number;
}): Promise<{ assessment: WithdrawalAssessment; transaction: PreparedWithdrawalTransaction }> {
  const config = channelConfigFromMandate(input.cfg, input.payerAuthorizer);
  const assessment = assessWithdrawal(config, input.snapshot, input.liabilityBaseUnits, input.nowSeconds);
  if (!assessment.canPrepare) throw new Error(assessment.reason ?? "Withdrawal is not ready");
  const amountBaseUnits = assessment.kind === "initiate" ? assessment.recoverableBaseUnits : assessment.pendingBaseUnits;
  const callData = encodeWithdrawalCall(assessment.kind, config, assessment.kind === "initiate" ? amountBaseUnits : undefined);
  const publicClient = createPublicClient({ transport: http(input.cfg.rpcUrl, { timeout: 15_000, retryCount: 1 }) });
  if (await publicClient.getChainId() !== BASE_SEPOLIA_CHAIN_ID) throw new Error("Withdrawal RPC is not Base mainnet");
  // eth_call from the configured payer proves the exact contract entry point is currently executable.
  await publicClient.call({ account: config.payer, to: BATCH_SETTLEMENT_ADDRESS, data: callData, value: 0n });
  const [nonce, gasEstimate, fees, payerNativeBalance, sourceBlock] = await Promise.all([
    publicClient.getTransactionCount({ address: config.payer, blockTag: "pending" }),
    publicClient.estimateGas({ account: config.payer, to: BATCH_SETTLEMENT_ADDRESS, data: callData, value: 0n }),
    publicClient.estimateFeesPerGas({ chain: undefined, type: "eip1559" }),
    publicClient.getBalance({ address: config.payer, blockTag: "pending" }),
    publicClient.getBlockNumber({ cacheTime: 0 }),
  ]);
  if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) throw new Error("RPC did not provide EIP-1559 fee fields");
  const gas = (gasEstimate * 120n + 99n) / 100n;
  const maxGasCostWei = gas * fees.maxFeePerGas;
  if (payerNativeBalance < maxGasCostWei) throw new Error("Ledger payer has insufficient Base mainnet ETH for the reviewed withdrawal transaction");
  const encoded = serializeUnsignedWithdrawal({
    kind: assessment.kind,
    config,
    channelId: assessment.channelId,
    amountBaseUnits,
    nonce,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  const base = {
    version: 1 as const,
    kind: assessment.kind,
    network: "eip155:8453" as const,
    chainId: 8453 as const,
    channelId: assessment.channelId,
    contract: getAddress(BATCH_SETTLEMENT_ADDRESS),
    payer: config.payer,
    token: config.token,
    receiver: config.receiver,
    withdrawDelay: config.withdrawDelay,
    amountBaseUnits,
    callData: encoded.callData,
    selector: encoded.selector,
    nonce,
    gas: String(gas),
    maxFeePerGas: String(fees.maxFeePerGas),
    maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas),
    maxGasCostWei: String(maxGasCostWei),
    payerNativeBalanceWei: String(payerNativeBalance),
    unsignedSerialized: encoded.unsignedSerialized,
    unsignedHash: encoded.unsignedHash,
    preparedAt: new Date().toISOString(),
    sourceBlock: String(sourceBlock),
    stateFingerprint: withdrawalStateFingerprint(input.snapshot, input.liabilityBaseUnits),
  };
  return { assessment, transaction: { ...base, planHash: digest(base) } };
}

export function unsignedWithdrawalBytes(plan: PreparedWithdrawalTransaction): Uint8Array {
  const parsed = parseTransaction(plan.unsignedSerialized);
  if (parsed.chainId !== BASE_SEPOLIA_CHAIN_ID || !parsed.to || getAddress(parsed.to) !== getAddress(BATCH_SETTLEMENT_ADDRESS) || parsed.data !== plan.callData || (parsed.value ?? 0n) !== 0n) {
    throw new Error("Stored withdrawal plan is not the reviewed Base mainnet escrow transaction");
  }
  return hexToBytes(plan.unsignedSerialized);
}
