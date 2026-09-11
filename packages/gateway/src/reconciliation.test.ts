import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeEventTopics, encodeAbiParameters, erc20Abi, type Hex, type TransactionReceipt } from 'viem';
import { BATCH_SETTLEMENT_ADDRESS } from '@x402/evm';
import { assertRefundTransfers, assertFundingSnapshot, type ChannelSnapshot } from './reconciliation.ts';
const payer = '0x0000000000000000000000000000000000000001';
const asset = '0x0000000000000000000000000000000000000002';
const other = '0x0000000000000000000000000000000000000003';
const txHash = `0x${'11'.repeat(32)}` as Hex;
function receipt(from: Hex = BATCH_SETTLEMENT_ADDRESS, to: Hex = payer, token: Hex = asset, amount = 4940000n): Pick<TransactionReceipt,'status'|'logs'|'transactionHash'> {
  const rawTopics = encodeEventTopics({abi:erc20Abi,eventName:'Transfer',args:{from,to}});
  const topics = rawTopics.map(topic => { if (typeof topic !== 'string') throw new Error('Expected concrete event topics'); return topic; });
  const [first, ...rest] = topics;
  if (!first) throw new Error('Missing event signature');
  return { status:'success', transactionHash:txHash, logs:[{
    address:token, blockHash:txHash, blockNumber:1n, logIndex:0, removed:false, transactionHash:txHash, transactionIndex:0,
    topics:[first, ...rest],
    data:encodeAbiParameters([{type:'uint256'}],[amount]),
  }] };
}
test('refund proof requires an exact token transfer from escrow to the expected payer', () => {
  assert.equal(assertRefundTransfers(receipt(),{asset,payer,expectedBaseUnits:'4940000'}),'4940000');
  for (const changed of [receipt(other),receipt(undefined,other),receipt(undefined,payer,other),receipt(undefined,payer,asset,1n),{...receipt(),logs:[]}]) {
    assert.throws(()=>assertRefundTransfers(changed,{asset,payer,expectedBaseUnits:'4940000'}),/does not prove/);
  }
  assert.throws(()=>assertRefundTransfers({...receipt(),status:'reverted'},{asset,payer,expectedBaseUnits:'4940000'}),/reverted/);
});
test('a successful merchant response alone cannot establish funded channel authority', () => {
  const snapshot: ChannelSnapshot = {network:'eip155:84532',blockNumber:'1',observedAt:new Date().toISOString(),channelId:txHash,
    balanceBaseUnits:'5000000',claimedBaseUnits:'60000',payerBalanceBaseUnits:'0',receiverBalanceBaseUnits:'0',
    receiverAggregateClaimedBaseUnits:'60000',receiverAggregateSettledBaseUnits:'0',withdrawalAmountBaseUnits:'0',withdrawalInitiatedAt:0,refundNonce:'0'};
  assertFundingSnapshot(snapshot,'5000000');
  assert.throws(()=>assertFundingSnapshot({...snapshot,balanceBaseUnits:'0'},'5000000'),/exact authorized/);
  assert.throws(()=>assertFundingSnapshot({...snapshot,withdrawalAmountBaseUnits:'1'},'5000000'),/withdrawal/);
});

test('lagging RPC snapshots retry the same read; contract errors do not trigger retries',async()=>{
  const {retryLaggingRpcRead}=await import('./reconciliation.ts');
  let calls=0;assert.equal(await retryLaggingRpcRead(async()=>{if(++calls===1)throw new Error('block not found');return 42;},1),42);assert.equal(calls,2);
  calls=0;await assert.rejects(()=>retryLaggingRpcRead(async()=>{calls++;throw new Error('execution reverted');},1),/reverted/);assert.equal(calls,1);
});

test('refund calldata is verified inside the stock multicall and cannot substitute another channel', async()=>{
 const {encodeFunctionData}=await import('viem');
 const {computeChannelId}=await import('@x402/evm/batch-settlement/client');
 const {assertRefundCall,REFUND_CALL_ABI}=await import('./reconciliation.ts');
 const config={payer,payerAuthorizer:other,receiver:other,receiverAuthorizer:payer,token:asset,withdrawDelay:86400,salt:txHash} as const;
 const channelId=computeChannelId(config,84532);
 const data=encodeFunctionData({abi:REFUND_CALL_ABI,functionName:'refundWithSignature',args:[config,70000n,0n,'0xab']});
 const expected={chainId:84532,channelId,asset,payer,receiver:other,amount:'70000'} as const;
 assertRefundCall(data,expected);
 assertRefundCall(encodeFunctionData({abi:REFUND_CALL_ABI,functionName:'multicall',args:[[data]]}),expected);
 assert.throws(()=>assertRefundCall(data,{...expected,amount:'1'}),/exactly one/);
 assert.throws(()=>assertRefundCall(data,{...expected,channelId:txHash}),/exactly one/);
 assert.throws(()=>assertRefundCall(encodeFunctionData({abi:REFUND_CALL_ABI,functionName:'multicall',args:[[data,data]]}),expected),/exactly one/);
});
