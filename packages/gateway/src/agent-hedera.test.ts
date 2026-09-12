import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PrivateKey,TransferTransaction,TransactionId,AccountId} from '@x402/hedera';
import {validateHederaScope,assertHederaOffer,assertHederaPayload,transactionIdForMirror,hederaSettlementVerifier,AGENT_HEDERA_USDC} from './agent-hedera.ts';
import type {PaymentPayload,PaymentRequirements} from '@x402/core/types';
const scope={accountId:'0.0.5001',payTo:'0.0.5002',feePayer:'0.0.5003',endpoint:'http://127.0.0.1:8423/tools/hedera-analysis'};
const offer:PaymentRequirements={scheme:'exact',network:'hedera:testnet',asset:AGENT_HEDERA_USDC,amount:'2000',payTo:scope.payTo,maxTimeoutSeconds:120,extra:{feePayer:scope.feePayer}};
async function signed(amount=2000,recipient=scope.payTo){
 const tx=new TransferTransaction().setTransactionId(TransactionId.generate(scope.feePayer)).setNodeAccountIds([AccountId.fromString('0.0.3')]).setTransactionValidDuration(120)
  .addTokenTransfer(AGENT_HEDERA_USDC,scope.accountId,-amount).addTokenTransfer(AGENT_HEDERA_USDC,recipient,amount).freeze();
 await tx.sign(PrivateKey.generateECDSA());return Buffer.from(tx.toBytes()).toString('base64');
}
test('Hedera authority and offers reject mainnet, changed fee payer and self-payments',()=>{
 assert.deepEqual(validateHederaScope(scope),scope);
 assert.throws(()=>validateHederaScope({...scope,payTo:scope.accountId}),/differ/);
 assert.throws(()=>validateHederaScope({...scope,endpoint:'http://example.org/tools/hedera-analysis'}),/reviewed/);
 assert.throws(()=>assertHederaOffer(scope,{...offer,network:'hedera:mainnet'}),/changed/);
 assert.throws(()=>assertHederaOffer(scope,{...offer,extra:{feePayer:'0.0.9'}}),/changed/);
 assert.throws(()=>assertHederaOffer(scope,{...offer,asset:'0.0.0'}),/changed/);
});
test('actual SDK Hedera bytes are bound to exactly two reviewed token transfers',async()=>{
 const bytes=await signed();assert.match(assertHederaPayload(scope,offer,bytes),/^0\.0\.5003-\d+-\d+$/);
 assert.throws(()=>assertHederaPayload(scope,{...offer,amount:'1999'},bytes),/amount/);
 assert.throws(()=>assertHederaPayload({...scope,payTo:'0.0.9999'},{...offer,payTo:'0.0.9999'},bytes),/recipient/);
 assert.equal(transactionIdForMirror('0.0.5003@1789171200.1'),'0.0.5003-1789171200-000000001');
});
test('Hedera settlement requires the signed transaction ID AND independently matching mirror transfers',async()=>{
 const transaction=await signed(), id=assertHederaPayload(scope,offer,transaction);
 const payload={x402Version:2,payload:{transaction},accepted:offer} as PaymentPayload;
 const verifier=hederaSettlementVerifier({fetch:(async()=>new Response(JSON.stringify({transactions:[{transaction_id:id,result:'SUCCESS',token_transfers:[{token_id:AGENT_HEDERA_USDC,account:scope.accountId,amount:-2000},{token_id:AGENT_HEDERA_USDC,account:scope.payTo,amount:2000}]}]}))) as typeof fetch});
 await verifier({transaction:id,payload,offer,scope});
 await assert.rejects(verifier({transaction:'0.0.5003-1-000000001',payload,offer,scope}),/does not match/);
 const changed=hederaSettlementVerifier({fetch:(async()=>new Response(JSON.stringify({transactions:[{transaction_id:id,result:'SUCCESS',token_transfers:[{token_id:AGENT_HEDERA_USDC,account:scope.accountId,amount:-2000},{token_id:AGENT_HEDERA_USDC,account:'0.0.9999',amount:2000}]}]}))) as typeof fetch});
 await assert.rejects(changed({transaction:id,payload,offer,scope}),/does not prove/);
});
