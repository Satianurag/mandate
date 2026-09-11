/** Live read-only prerequisites. No signature, transfer, provisioning or mainnet fallback. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createPublicClient, http, erc20Abi, formatEther, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { BATCH_SETTLEMENT_ADDRESS } from '@x402/evm';
import { BASE_SEPOLIA } from '../packages/gateway/src/facilitators.ts';
import { withSecret } from '../packages/gateway/src/keyring.ts';
import { ensureWalletPass } from './load-wallet-pass.mjs';
import { loadOperatorEnvironment } from './operator-env.mjs';
await loadOperatorEnvironment(); await ensureWalletPass();
const out = {checkedAt:new Date().toISOString(),testnetOnly:true,transactions:0,checks:{}};
const rpcUrl=process.env.MANDATE_EVM_RPC_URL ?? 'https://sepolia.base.org';
const rpc=createPublicClient({transport:http(rpcUrl,{timeout:12000,retryCount:1})});
if(await rpc.getChainId()!==84532)throw new Error('RPC is not Base Sepolia');
let payer=process.env.MANDATE_PAYER;
if(!payer){
 const {parseMandateFile}=await import('../packages/gateway/src/mandate-config.ts');
 const saved=await readFile(process.env.MANDATE_FILE??'state/live/operator/active-mandate.yaml','utf8').catch(()=>null);
 if(saved)payer=parseMandateFile(saved).operatorAddress;
}
if(!payer){
 const {DmkEvmSigner}=await import('../packages/gateway/src/dmksigner.ts');
 const {resetDmk}=await import('../packages/gateway/src/dmk-session.ts');
 try{payer=(await DmkEvmSigner.create({timeoutMs:15000})).address;}finally{resetDmk();}
}
for (const [name, file] of [['facilitator','mandate-facilitator'],['authorizer','mandate-authorizer'],['session','mandate-session']]) {
  out.checks[name]=await withSecret(file,await readFile(`secrets/${file}.enc`),async bytes=>{
    if(bytes.length!==32)throw new Error('Invalid sealed key length');
    const address=privateKeyToAccount(`0x${bytes.toString('hex')}`).address;
    return {address,eth:formatEther(await rpc.getBalance({address}))};
  });
}
out.checks.payer={address:payer,usdc:formatUnits(await rpc.readContract({address:BASE_SEPOLIA.usdc,abi:erc20Abi,functionName:'balanceOf',args:[payer]}),6),eth:formatEther(await rpc.getBalance({address:payer}))};
out.checks.escrow={address:BATCH_SETTLEMENT_ADDRESS,deployed:(await rpc.getCode({address:BATCH_SETTLEMENT_ADDRESS}))?.length>2};
if(process.env.MANDATE_HEDERA_ACCOUNT_ID){
 const r=await fetch(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${process.env.MANDATE_HEDERA_ACCOUNT_ID}`,{signal:AbortSignal.timeout(12000)});
 if(!r.ok)throw new Error(`Testnet mirror HTTP ${r.status}`);
 const a=await r.json();out.checks.hedera={account:a.account,balanceTinybars:String(a.balance?.balance),topic:process.env.MANDATE_HCS_TOPIC_ID??null};
}
await mkdir('.live-results/repair',{recursive:true});await writeFile('.live-results/repair/live-preflight-latest.json',JSON.stringify(out,null,2));
console.log(JSON.stringify(out,null,2));
