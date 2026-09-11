#!/usr/bin/env node
/** Restart only Mandate's own supervisor after verifying that no task is in flight. */
import {readFile,writeFile,open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {localOperatorClient} from './operator-client.mjs';
const root=new URL('..',import.meta.url).pathname;
const api=await localOperatorClient();
const state=await api('/api/state');
if(state.tasks.some(t=>['queued','running','awaiting_device','awaiting_signature'].includes(t.state)))throw new Error('Do not restart while a device or payment task is pending');
const managed=JSON.parse(await readFile(`${root}/state/live/stack.json`,'utf8'));
const expected=Number(await readFile(`${root}/.live-results/repair/stack-supervisor.pid`,'utf8'));
if(managed.pid!==expected)throw new Error('Supervisor identity mismatch');
process.kill(expected,'SIGTERM');
for(let i=0;i<80;i++){try{process.kill(expected,0);}catch(error){if(error.code==='ESRCH')break;throw error;}await new Promise(r=>setTimeout(r,100));}
const logfile=await open(`${root}/.live-results/repair/stack.log`,'a');
const child=spawn(process.execPath,['--experimental-strip-types',`${root}/scripts/stack.mjs`],{cwd:root,env:{...process.env,MANDATE_AUTO_SETTLEMENT:process.env.MANDATE_AUTO_SETTLEMENT??'0'},stdio:['ignore',logfile.fd,logfile.fd],detached:true});
child.unref();await writeFile(`${root}/.live-results/repair/stack-supervisor.pid`,String(child.pid));await logfile.close();
console.log(`Restarted only the Mandate supervisor: PID ${child.pid}`);
