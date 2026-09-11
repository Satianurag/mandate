#!/usr/bin/env node
/** CLI companion to the same authenticated workspace; it never spawns a second payment stack. */
import {localOperatorClient} from './operator-client.mjs';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const action=process.argv[2]??'state';
if(process.argv.includes('--help')){
 console.log('Usage: node scripts/operator-task.mjs state | query [--query-file PATH] [--request-id ID] [--authorize-funding] | refund --confirm-testnet | reconcile [--request-id ID]');process.exit(0);
}
const api=await localOperatorClient();
const flag=name=>{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:undefined;};
if(action==='state'){const s=await api('/api/state');console.log(JSON.stringify({config:s.config,financial:s.financial,tasks:s.tasks},null,2));process.exit(0);}
if(action==='reconcile'){console.log(JSON.stringify(await api('/api/reconcile',flag('--request-id')?{requestId:flag('--request-id')}:{}),null,2));process.exit(0);}
let accepted;
if(action==='query'){
 const state=await api('/api/state');
 if(!state.config)throw new Error('Review authority in the operator workspace first');
 const queryFile=flag('--query-file');
 const query=queryFile?await readFile(queryFile,'utf8'):state.comparisonQuery;
 const requestId=flag('--request-id')??randomUUID();
 console.log(`Observing request ${requestId}; reuse this ID after a lost response, do not create a replacement payment.`);
 accepted=await api('/api/tasks',{query,requestId,authorizeFunding:process.argv.includes('--authorize-funding')});
}else if(action==='refund'){
 if(!process.argv.includes('--confirm-testnet'))throw new Error('Review the workspace and pass --confirm-testnet to request recovery of its remaining testnet funds');
 accepted=await api('/api/refund',{confirm:'request_refund'});
}else throw new Error('Unknown action. Run with --help.');
let last='';const deadline=Date.now()+16*60000;
while(Date.now()<deadline){
 const {task}=await api(`/api/tasks/${accepted.task.id}`);
 if(task.state!==last){console.log(`Task ${task.id}: ${task.state}`);last=task.state;}
 if(['succeeded','reconciled'].includes(task.state)){console.log(JSON.stringify(task.result?JSON.parse(task.result):task,null,2));process.exit(0);}
 if(['blocked','failed','uncertain','interrupted'].includes(task.state))throw new Error(`${task.state}: ${task.error}. Reconcile this request before retrying.`);
 await new Promise(resolve=>setTimeout(resolve,1500));
}
throw new Error(`Task ${accepted.task.id} is still pending. Its outcome must be observed or reconciled, not replaced.`);
