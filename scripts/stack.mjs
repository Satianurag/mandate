#!/usr/bin/env node
/** Trusted process supervisor: no device signature, channel funding or paid task at startup. */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { loadOperatorEnvironment } from './operator-env.mjs';
import { ensureWalletPass } from './load-wallet-pass.mjs';
const root = new URL('..',import.meta.url).pathname;
await loadOperatorEnvironment(root);
if(!await ensureWalletPass())throw new Error('Provision the Ledger Key Ring password in the OS keychain first');
const state=resolve(process.env.MANDATE_STACK_STATE ?? `${root}/state/live`);
await mkdir(state,{recursive:true,mode:0o700});
const tokenPath=`${state}/merchant-admin-token`;
try {await access(tokenPath);} catch {await writeFile(tokenPath,randomBytes(32).toString('base64url'),{mode:0o600,flag:'wx'});}
const original = parse(await readFile(`${root}/mandate.yaml`,'utf8').catch(()=>'')) ?? {};
const receiver=process.env.MANDATE_SERVICE_RECEIVER ?? original.receiver;
if(!/^0x[0-9a-fA-F]{40}$/.test(receiver??''))throw new Error('Set the public MANDATE_SERVICE_RECEIVER before booting');
const children=[];
let closing=false;
async function cleanup(){
 if(closing)return;closing=true;
 for(const child of children)child.kill('SIGTERM');
 await Promise.all(children.map(child=>new Promise(resolve=>{if(child.exitCode!==null)return resolve(); child.once('exit',resolve);setTimeout(()=>{child.kill('SIGKILL');resolve();},5000).unref();})));
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void cleanup().then(()=>process.exit(0));});
function start(name,file,extra){
 const c=spawn(process.execPath,['--experimental-strip-types',`${root}/${file}`],{cwd:root,env:{...process.env,...extra},stdio:['ignore','pipe','pipe']});
 children.push(c); for(const output of [c.stdout,c.stderr])output.on('data',b=>process.stdout.write(`[${name}] ${String(b)}`));
 c.on('exit',code=>{if(!closing){console.error(`${name} exited ${code}`);void cleanup().then(()=>process.exit(1));}}); return c;
}
async function wait(url,status){
 const until=Date.now()+60000;
 while(Date.now()<until){if(closing)throw new Error('Stack startup failed');try{const r=await fetch(url,{signal:AbortSignal.timeout(2000)});if(r.status===status)return;}catch{} await new Promise(r=>setTimeout(r,300));}
 throw new Error(`Dependency not ready: ${url}`);
}
try{
 start('facilitator','packages/facilitator/src/index.ts',{MANDATE_EVM_RPC_URL:process.env.MANDATE_EVM_RPC_URL??'https://sepolia.base.org',MANDATE_ENABLE_HEDERA_EVM:'0',FACILITATOR_PORT:'8406',FACILITATOR_HOST:'127.0.0.1'});
 await wait('http://127.0.0.1:8406/supported',200);
 start('merchant','packages/mandate-service/src/index.ts',{MANDATE_SERVICE_RECEIVER:receiver,MANDATE_SERVICE_CHAIN_ID:'84532',MANDATE_SERVICE_PORT:'8405',MANDATE_SERVICE_HOST:'127.0.0.1',MANDATE_FACILITATOR_URL:'http://127.0.0.1:8406',MANDATE_EVM_RPC_URL:process.env.MANDATE_EVM_RPC_URL??'https://sepolia.base.org',MANDATE_SERVICE_STATE:`${state}/merchant`,MANDATE_MERCHANT_ADMIN_TOKEN_FILE:tokenPath,MANDATE_AUTO_SETTLEMENT:process.env.MANDATE_AUTO_SETTLEMENT??'1'});
 await wait('http://127.0.0.1:8405/analytics',402);
 start('operator','packages/gateway/src/operator.ts',{MANDATE_OPERATOR_STATE:`${state}/operator`,MANDATE_MERCHANT_ADMIN_TOKEN_FILE:tokenPath,MANDATE_LOCAL_MERCHANT_URL:'http://127.0.0.1:8405',MANDATE_LOCAL_MERCHANT_STATE:`${state}/merchant`,MANDATE_DEVICE_TIMEOUT_MS:'600000'});
 await wait('http://127.0.0.1:8410/healthz',200);
 await writeFile(`${state}/stack.json`,JSON.stringify({pid:process.pid,children:children.map(c=>c.pid),state,operator:'http://127.0.0.1:8410',startedAt:new Date().toISOString()}));
 console.log(`STACK_READY http://127.0.0.1:8410 state=${state}. Startup performed no paid requests.`);
 if(process.argv.includes('--smoke')){await cleanup();process.exit(0);}
}catch(error){console.error(error.message);await cleanup();process.exit(1);}
