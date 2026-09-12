#!/usr/bin/env node
import {spawn} from 'node:child_process';
const url='http://127.0.0.1:8410/';
const response=await fetch(url+'healthz',{signal:AbortSignal.timeout(3000)});
if(!response.ok)throw new Error('Start Mandate with npm start');
const command=process.platform==='darwin'?'open':process.platform==='linux'?'xdg-open':null;
if(!command)throw new Error('Open '+url+' in your browser');
const child=spawn(command,[url],{stdio:'ignore'});
child.on('error',e=>{console.error(e.message);process.exitCode=1;});
console.log('Opening '+url);
