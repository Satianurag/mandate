#!/usr/bin/env node
// Read-only chain verification. This script cannot sign or submit a transaction.
import {readFile,writeFile} from 'node:fs/promises';
import {confirmRefundTransaction} from '../packages/gateway/src/reconciliation.ts';
const config=JSON.parse(await readFile('.live-results/repair/live-config.json','utf8'));
const proof=await confirmRefundTransaction({rpcUrl:config.rpcUrl,chainId:84532,
 channelId:'0xfe09c8abe0e73fdb6d6b9631b17fe712c9712bf731079a2ffdd0f05698cce29a',
 asset:config.asset,payer:config.operatorAddress,receiver:config.receiver,
 transaction:'0x64ecbc01ebe9d608141e59776ee3309e0f25d2db8927c924f903ced8e4472e39',
 expectedBaseUnits:'70000',liabilityBaseUnits:'30000'});
await writeFile('.live-results/repair/refund-chain-proof.json',JSON.stringify(proof,null,2));
console.log(JSON.stringify(proof,null,2));
