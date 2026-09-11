#!/usr/bin/env node
/** Deterministic repository consistency checks; no network, wallet or application mutation. */
import {readFile,readdir,access} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=new URL('..',import.meta.url).pathname;
const failures=[];
const check=(condition,message)=>{if(!condition)failures.push(message);};
const docs=['README.md','DX.md',...(await readdir(join(root,'docs'))).filter(name=>name.endsWith('.md')).map(name=>`docs/${name}`)];
for(const file of docs){
 const text=await readFile(join(root,file),'utf8');
 for(const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)){
  const href=match[1];if(/^(?:https?:|mailto:|#)/.test(href))continue;
  check(!href.startsWith('sandbox:'),`${file}: obsolete chat sandbox link ${href}`);
  if(href.startsWith('sandbox:'))continue;
  const local=href.split('#')[0];if(!local)continue;
  try{await access(resolve(root,dirname(file),decodeURIComponent(local)));}catch{failures.push(`${file}: missing local link ${href}`);}
 }
}
for(const pkg of ['gateway','facilitator','service','mandate-service']){
 const folder=join(root,'packages',pkg,'src');
 for(const file of await readdir(folder)){
  if(!file.endsWith('.ts')||file.endsWith('.test.ts')||file.endsWith('.d.ts'))continue;
  const text=await readFile(join(folder,file),'utf8');
  check(!/from\s+['"][^'"]*(?:test-support|facilitator-stub)/.test(text),`${pkg}/${file}: runtime imports a test double`);
  check(!/\.forMainnet\s*\(/.test(text),`${pkg}/${file}: mainnet financial client in runtime`);
 }
}
const rootPackage=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));
for(const [name,range] of Object.entries(rootPackage.devDependencies??{}))check(lock.packages[''].devDependencies?.[name]===range,`Lockfile root dependency mismatch: ${name}`);
const tracked=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
for(const name of tracked)check(!/^(?:secrets\/|state\/|\.env(?:\.|$))/.test(name),`Private local state tracked: ${name}`);
execFileSync('git',['diff','--check'],{cwd:root,stdio:'pipe'});
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
else console.log(JSON.stringify({ok:true,markdownDocuments:docs.length,runtimeTestDoubleImports:0,mainnetClientConstructors:0,trackedPrivateState:0,lockfileRootMatches:true}));
