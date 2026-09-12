#!/usr/bin/env node
/** Isolated agent stack. Existing operator, Tailscale and tunnels remain untouched. */
import {spawn} from 'node:child_process';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {resolve,join} from 'node:path';
import {ensureWalletPass} from './load-wallet-pass.mjs';import {loadOperatorEnvironment} from './operator-env.mjs';
const root=resolve(new URL('..',import.meta.url).pathname),state=resolve(process.env.MANDATE_AGENT_STATE??join(root,'state/agents'));
await readFile(join(state,'operator/agent-runtime.json'));await mkdir(state,{recursive:true,mode:0o700});
await loadOperatorEnvironment(root);if(!await ensureWalletPass())throw new Error('Unlock the provisioned Key Ring through the OS keychain');
const children=[];let closing=false;
async function close(){if(closing)return;closing=true;for(const c of children)c.kill('SIGTERM');await Promise.all(children.map(c=>new Promise(r=>{if(c.exitCode!==null)return r();c.once('exit',r);setTimeout(()=>{c.kill('SIGKILL');r();},15000).unref();})));}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void close().then(()=>process.exit(0)));
function start(label,file,env){const c=spawn(process.execPath,['--experimental-strip-types',join(root,file)],{cwd:root,env:{...process.env,MANDATE_AGENT_STATE:state,...env},stdio:['ignore','pipe','pipe']});children.push(c);for(const p of [c.stdout,c.stderr])p.on('data',b=>process.stdout.write(`[${label}] ${b}`));c.once('exit',code=>{if(!closing){console.error(`${label} exited ${code}`);void close().then(()=>process.exit(1));}});}
async function wait(url){for(let n=0;n<100;n++){if(closing)throw new Error('Agent stack stopped during startup');try{const r=await fetch(url,{signal:AbortSignal.timeout(1000)});if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}throw new Error(`Dependency not ready: ${url}`);}
try{
 start('facilitator','packages/facilitator/src/index.ts',{MANDATE_EVM_RPC_URL:'https://sepolia.base.org',MANDATE_ENABLE_HEDERA_EVM:'0',FACILITATOR_PORT:'8426',FACILITATOR_HOST:'127.0.0.1'});await wait('http://127.0.0.1:8426/supported');
 start('services','scripts/agent-tool-services.mjs',{});await wait('http://127.0.0.1:8425/healthz');await wait('http://127.0.0.1:8423/healthz');
 start('workspace','packages/gateway/src/operator.ts',{MANDATE_OPERATOR_STATE:join(state,'operator'),MANDATE_CONSOLE_PORT:'8420'});await wait('http://127.0.0.1:8420/healthz');
 await writeFile(join(state,'stack.json'),JSON.stringify({pid:process.pid,children:children.map(c=>c.pid),operator:'http://127.0.0.1:8420',startedAt:new Date().toISOString()}),{mode:0o600});
 console.log('AGENT_STACK_READY http://127.0.0.1:8420. Startup never signs, funds, or runs an agent.');
 if(process.argv.includes('--smoke')){await close();process.exit(0);}
}catch(e){console.error(e.message);await close();process.exit(1);}
