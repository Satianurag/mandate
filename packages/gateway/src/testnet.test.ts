import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertTestnetNetwork, assertTestnetChain, assertHederaTestnet } from './testnet.ts';
import { createSealedHederaSigner } from './hedera.ts';
import { caip2ForChainId, viemChain } from './chains.ts';

test('every unsupported or mainnet network is rejected before signing', async () => {
  for (const network of ['hedera:mainnet','hedera:previewnet','eip155:1','eip155:8453','eip155:295','eip155:137',null,undefined]) assert.throws(()=>assertTestnetNetwork(network),/Testnet-only/);
  for (const chain of [1,8453,295,137,'84532',null]) assert.throws(()=>assertTestnetChain(chain),/Testnet-only/);
  for (const network of ['mainnet','hedera:mainnet','previewnet']) assert.throws(()=>assertHederaTestnet(network),/Testnet-only/);
  for (const chain of [1,8453,295]) {
    assert.throws(()=>caip2ForChainId(chain),/not a mandate testnet/);
    assert.throws(()=>viemChain(chain,'https://example.invalid'),/not a mandate testnet/);
  }
  const signer=createSealedHederaSigner(Buffer.from('not-a-key-and-must-never-be-unsealed'),'0.0.1');
  await assert.rejects(async()=>signer.createPartiallySignedTransferTransaction({scheme:'exact',network:'hedera:mainnet',asset:'0.0.0',amount:'1',payTo:'0.0.2',maxTimeoutSeconds:60,extra:{}}),/Testnet-only/);
});
test('only the three supported testnet payment networks pass the guard',()=>{
  for(const network of ['eip155:84532','eip155:296','hedera:testnet'])assertTestnetNetwork(network);
  assertTestnetChain(84532);assertTestnetChain(296);assertHederaTestnet('testnet');
});
