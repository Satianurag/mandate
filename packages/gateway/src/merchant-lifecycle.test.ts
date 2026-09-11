import {test} from 'node:test';
import assert from 'node:assert/strict';
import {completeMerchantLifecycle} from './merchant-lifecycle.ts';
test('restart after a claim still sweeps existing revenue when there are no new claimable vouchers',async()=>{
 let sweeps=0;const events:string[]=[];
 const result=await completeMerchantLifecycle({claim:async()=>[],receiverState:async()=>({claimed:30000n,settled:0n}),settle:async()=>{sweeps++;return {transaction:'confirmed-sweep'};},record:kind=>events.push(kind)});
 assert.equal(sweeps,1);assert.equal(result.alreadySettled,false);assert.deepEqual(events,['merchant.revenue_settled']);
});
test('claim confirmation is retained even if the subsequent sweep fails ambiguously',async()=>{
 const events:string[]=[];let attempts=0;
 await assert.rejects(()=>completeMerchantLifecycle({claim:async()=>[{vouchers:1,transaction:'confirmed-claim'}],receiverState:async()=>({claimed:3n,settled:0n}),settle:async()=>{attempts++;throw new Error('transport disconnected after send');},record:kind=>events.push(kind)}),/transport disconnected/);
 assert.deepEqual(events,['merchant.claim_confirmed']);assert.equal(attempts,1);
});
test('only a definite pre-transaction nothing-to-settle result is retried',async()=>{
 let attempts=0;
 const result=await completeMerchantLifecycle({claim:async()=>[],receiverState:async()=>({claimed:3n,settled:0n}),settle:async()=>{if(++attempts===1)throw new Error('invalid_batch_settlement_evm_nothing_to_settle');return {transaction:'confirmed'};},record:()=>{},retryDelayMs:1});
 assert.equal(attempts,2);assert.equal(result.settle?.transaction,'confirmed');
});
test('already-settled revenue does not cause another sweep transaction',async()=>{
 const result=await completeMerchantLifecycle({claim:async()=>[],receiverState:async()=>({claimed:3n,settled:3n}),settle:async()=>{throw new Error('must not send');},record:()=>{}});
 assert.equal(result.alreadySettled,true);
});
