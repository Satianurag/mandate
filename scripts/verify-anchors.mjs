#!/usr/bin/env node
/** Read-only verification against Hedera testnet consensus mirror and independently resolved account key. */
import {writeFile} from 'node:fs/promises';
import {PublicKey} from '@hiero-ledger/sdk';
import {verifyAnchor} from '../packages/gateway/src/evidence-publisher.ts';
import {localOperatorClient} from './operator-client.mjs';
import {loadOperatorEnvironment} from './operator-env.mjs';
import assert from 'node:assert/strict';
await loadOperatorEnvironment();
const account=process.env.MANDATE_HEDERA_ACCOUNT_ID,topic=process.env.MANDATE_HCS_TOPIC_ID;
const base='https://testnet.mirrornode.hedera.com';
const accountResponse=await fetch(`${base}/api/v1/accounts/${account}`,{signal:AbortSignal.timeout(12000)});
assert.equal(accountResponse.status,200);
const accountData=await accountResponse.json();assert.equal(accountData.account,account);assert.equal(accountData.key._type,'ECDSA_SECP256K1');
const expected={account,publicKey:PublicKey.fromStringECDSA(accountData.key.key).toStringDer()};
const api=await localOperatorClient();const state=await api('/api/state');
const allRecords=[...state.events,...(state.financial?.events??[]),...(state.merchantEvidence?.events??[])];
const records=allRecords.filter(e=>e.anchor_state==='confirmed');
const proof={checkedAt:new Date().toISOString(),network:'hedera:testnet',topic,expectedPublisher:expected,verified:[],failures:[],pending:allRecords.filter(e=>e.anchor_state!=='confirmed').length};
for(const event of records){
 const receipt=JSON.parse(event.receipt);
 try {
  const response=await fetch(`${base}/api/v1/topics/${topic}/messages/${receipt.topicSequenceNumber}`,{signal:AbortSignal.timeout(12000)});
  assert.equal(response.status,200);
  const message=await response.json();
  const anchor=JSON.parse(Buffer.from(message.message,'base64').toString('utf8'));
  assert.equal(message.topic_id,topic);assert.equal(String(message.sequence_number),String(receipt.topicSequenceNumber));
  assert.equal(verifyAnchor(anchor,expected,event),true,'Signature, author, original event hash and previous hash must all verify');
  assert.equal(Buffer.from(message.running_hash,'base64').toString('hex'),receipt.topicRunningHash);
  proof.verified.push({eventId:event.id,kind:event.kind,sequence:message.sequence_number,consensusTimestamp:message.consensus_timestamp,eventHash:event.hash,signatureVerified:true});
 }catch(error){proof.failures.push({eventId:event.id,error:error.message});}
}
proof.ok=proof.verified.length>0&&proof.failures.length===0;
await writeFile('.live-results/repair/hcs-readback.json',JSON.stringify(proof,null,2));
console.log(JSON.stringify({ok:proof.ok,network:proof.network,topic,independentlyVerified:proof.verified.length,failures:proof.failures,pending:proof.pending},null,2));
if(!proof.ok)process.exitCode=1;
