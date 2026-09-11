/** Read-only reconciliation of the deployed stock x402 escrow. */
import { assertTestnetChain } from './testnet.ts';
import { computeChannelId } from '@x402/evm/batch-settlement/client';
import { BATCH_SETTLEMENT_ADDRESS } from '@x402/evm';
import { createPublicClient, http, parseAbi, erc20Abi, getAddress, parseEventLogs, decodeFunctionData, type TransactionReceipt, type Hex } from 'viem';
export const ESCROW_READ_ABI = parseAbi([
  'function channels(bytes32 channelId) view returns (uint128 balance, uint128 totalClaimed)',
  'function receivers(address receiver,address token) view returns (uint128 totalClaimed,uint128 totalSettled)',
  'function pendingWithdrawals(bytes32 channelId) view returns (uint128 amount,uint40 initiatedAt)',
  'function refundNonce(bytes32 channelId) view returns (uint256)',
]);
export interface ChannelSnapshot {
  network: string; blockNumber: string; observedAt: string; channelId: Hex;
  balanceBaseUnits: string; claimedBaseUnits: string; payerBalanceBaseUnits: string;
  receiverBalanceBaseUnits: string; receiverAggregateClaimedBaseUnits: string;
  receiverAggregateSettledBaseUnits: string; withdrawalAmountBaseUnits: string;
  withdrawalInitiatedAt: number; refundNonce: string;
}
export async function snapshotChannel(opts: {
  rpcUrl: string; chainId: number; channelId: Hex; asset: Hex; payer: Hex; receiver: Hex;
  blockNumber?: bigint;
}): Promise<ChannelSnapshot> {
  assertTestnetChain(opts.chainId);
  const rpc = createPublicClient({transport:http(opts.rpcUrl,{timeout:15000,retryCount:1})});
  if (await rpc.getChainId() !== opts.chainId) throw new Error('Reconciliation RPC is on a different chain');
  const blockNumber = opts.blockNumber ?? await rpc.getBlockNumber({cacheTime:0});
  const [channel, receiver, withdrawal, refundNonce, payerBalance, receiverBalance] = await retryLaggingRpcRead(() => Promise.all([
    rpc.readContract({address:BATCH_SETTLEMENT_ADDRESS,abi:ESCROW_READ_ABI,functionName:'channels',args:[opts.channelId],blockNumber}),
    rpc.readContract({address:BATCH_SETTLEMENT_ADDRESS,abi:ESCROW_READ_ABI,functionName:'receivers',args:[opts.receiver,opts.asset],blockNumber}),
    rpc.readContract({address:BATCH_SETTLEMENT_ADDRESS,abi:ESCROW_READ_ABI,functionName:'pendingWithdrawals',args:[opts.channelId],blockNumber}),
    rpc.readContract({address:BATCH_SETTLEMENT_ADDRESS,abi:ESCROW_READ_ABI,functionName:'refundNonce',args:[opts.channelId],blockNumber}),
    rpc.readContract({address:opts.asset,abi:erc20Abi,functionName:'balanceOf',args:[opts.payer],blockNumber}),
    rpc.readContract({address:opts.asset,abi:erc20Abi,functionName:'balanceOf',args:[opts.receiver],blockNumber}),
  ]));
  return {network:`eip155:${opts.chainId}`,blockNumber:String(blockNumber),observedAt:new Date().toISOString(),channelId:opts.channelId,
    balanceBaseUnits:String(channel[0]),claimedBaseUnits:String(channel[1]),payerBalanceBaseUnits:String(payerBalance),
    receiverBalanceBaseUnits:String(receiverBalance),receiverAggregateClaimedBaseUnits:String(receiver[0]),
    receiverAggregateSettledBaseUnits:String(receiver[1]),withdrawalAmountBaseUnits:String(withdrawal[0]),
    withdrawalInitiatedAt:Number(withdrawal[1]),refundNonce:String(refundNonce)};
}
export function assertFundingSnapshot(snapshot: ChannelSnapshot, ceiling: string): void {
  if (BigInt(snapshot.balanceBaseUnits) !== BigInt(ceiling)) throw new Error('RPC did not confirm the exact authorized channel funding');
  if (BigInt(snapshot.claimedBaseUnits) > BigInt(snapshot.balanceBaseUnits)) throw new Error('Invalid channel accounting from RPC');
  if (BigInt(snapshot.withdrawalAmountBaseUnits) !== 0n) throw new Error('The channel has an outstanding withdrawal; spending remains blocked');
}
export function assertRefundTransfers(receipt: Pick<TransactionReceipt,'status'|'logs'|'transactionHash'>, opts: {
  asset: Hex; payer: Hex; expectedBaseUnits: string;
}): string {
  if (receipt.status !== 'success') throw new Error('Refund transaction reverted');
  let returned = 0n;
  for (const log of parseEventLogs({abi:erc20Abi,eventName:'Transfer',logs:receipt.logs})) {
    if (getAddress(log.address) === getAddress(opts.asset) &&
        getAddress(log.args.from) === getAddress(BATCH_SETTLEMENT_ADDRESS) &&
        getAddress(log.args.to) === getAddress(opts.payer)) returned += log.args.value;
  }
  if (returned <= 0n || returned !== BigInt(opts.expectedBaseUnits)) throw new Error('Receipt does not prove the expected token refund from escrow to the configured payer');
  return String(returned);
}

/** Read-only retries keep the SAME block, never mix balances from different snapshots. */
export async function retryLaggingRpcRead<T>(read:()=>Promise<T>, delayMs=1200):Promise<T> {
  for(let attempt=0;attempt<6;attempt++) {
    try{return await read();}catch(error){
      if(attempt===5 || !/block not found|header not found|unknown block|block is not available/i.test(String(error)))throw error;
      await new Promise(resolve=>setTimeout(resolve,delayMs));
    }
  }
  throw new Error('RPC snapshot could not be established');
}
export const REFUND_CALL_ABI = parseAbi([
  'function multicall(bytes[] data) returns (bytes[] results)',
  'function refundWithSignature((address payer,address payerAuthorizer,address receiver,address receiverAuthorizer,address token,uint40 withdrawDelay,bytes32 salt) config,uint128 amount,uint256 nonce,bytes receiverAuthorizerSignature)',
]);
export function assertRefundCall(data:Hex, expected:{chainId:number;channelId:Hex;asset:Hex;payer:Hex;receiver:Hex;amount:string}):void {
  assertTestnetChain(expected.chainId);
  let matches=0, visited=0;
  const visit=(input:Hex,depth:number)=>{
    if(depth>4 || ++visited>100)throw new Error('Refund call bundle exceeds the verification limit');
    let decoded:ReturnType<typeof decodeFunctionData<typeof REFUND_CALL_ABI>>;
    try{decoded=decodeFunctionData({abi:REFUND_CALL_ABI,data:input});}
    catch(error){if(depth===0)throw error;return;}
    if(decoded.functionName==='multicall'){for(const child of decoded.args[0])visit(child,depth+1);return;}
    const [config,amount]=decoded.args;
    if(computeChannelId(config,expected.chainId).toLowerCase()===expected.channelId.toLowerCase() &&
      getAddress(config.token)===getAddress(expected.asset) && getAddress(config.payer)===getAddress(expected.payer) &&
      getAddress(config.receiver)===getAddress(expected.receiver) && amount===BigInt(expected.amount))matches++;
  };
  visit(data,0);
  if(matches!==1)throw new Error('Refund transaction must contain exactly one matching channel and amount');
}
export async function confirmRefundTransaction(opts:{rpcUrl:string;chainId:number;channelId:Hex;asset:Hex;payer:Hex;receiver:Hex;transaction:Hex;expectedBaseUnits:string;liabilityBaseUnits:string}) {
  assertTestnetChain(opts.chainId);
  const rpc=createPublicClient({transport:http(opts.rpcUrl,{timeout:15000,retryCount:1})});
  if(await rpc.getChainId()!==opts.chainId)throw new Error('Refund RPC network mismatch');
  const [transaction,receipt]=await Promise.all([rpc.getTransaction({hash:opts.transaction}),rpc.getTransactionReceipt({hash:opts.transaction})]);
  if(!transaction.to || getAddress(transaction.to)!==getAddress(BATCH_SETTLEMENT_ADDRESS))throw new Error('Refund transaction did not call the pinned escrow');
  assertRefundCall(transaction.input,{...opts,amount:opts.expectedBaseUnits});
  const returned=assertRefundTransfers(receipt,{asset:opts.asset,payer:opts.payer,expectedBaseUnits:opts.expectedBaseUnits});
  const [before,after]=await Promise.all([
    snapshotChannel({...opts,blockNumber:receipt.blockNumber-1n}),
    snapshotChannel({...opts,blockNumber:receipt.blockNumber}),
  ]);
  if(BigInt(before.balanceBaseUnits)-BigInt(after.balanceBaseUnits)!==BigInt(returned) ||
     BigInt(after.payerBalanceBaseUnits)-BigInt(before.payerBalanceBaseUnits)!==BigInt(returned) ||
     after.balanceBaseUnits!==opts.liabilityBaseUnits || after.claimedBaseUnits!==opts.liabilityBaseUnits ||
     BigInt(after.refundNonce)!==BigInt(before.refundNonce)+1n)throw new Error('Confirmed transfer does not reconcile with this channel and payer');
  return {transaction:opts.transaction,returnedBaseUnits:returned,before,after,matchedChannelCalldata:true,network:`eip155:${opts.chainId}`};
}
