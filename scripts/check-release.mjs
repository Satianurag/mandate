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
for(const name of tracked)check(!/^(?:secrets\/|state\/|\.live-results\/|\.env(?:\.|$))/.test(name),`Private local state tracked: ${name}`);
const textFile=/^(?:Dockerfile[^/]*|\.dockerignore|\.gitignore|.*\.(?:md|mjs|js|cjs|ts|json|ya?ml|html|css|svg|sh|txt|toml|lock))$/;
const credentialRules=[
 ['private key PEM',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['GitHub access token',/\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
 ['AWS access key',/\bAKIA[0-9A-Z]{16}\b/],
 ['literal bearer credential',/\bBearer\s+[A-Za-z0-9_-]{40,}\b/],
 ['literal operator URL token',/#token=[A-Za-z0-9_-]{20,}/],
];
let scannedTextFiles=0;
for(const name of tracked){
 if(!textFile.test(name))continue;
 let text;try{text=await readFile(join(root,name),'utf8');}catch{continue;}
 scannedTextFiles++;
 check(!/(?:file:\/\/)?\/(?:Users|home)\/[^/\s]+\/|\/private\/tmp\//.test(text),`${name}: absolute local development path in tracked content`);
 for(const [label,pattern] of credentialRules)check(!pattern.test(text),`${name}: ${label} in tracked content`);
 const runtimeSource=!name.endsWith('.md')&&!name.includes('.test.')&&!name.includes('/test-support/')&&!name.includes('/skills/');
 if(runtimeSource){
  check(!/(?:^|\n)\s*(?:export\s+)?WALLET_PASS\s*=\s*(?!\$\(|\$\{|\$)[A-Za-z0-9._-]{8,}/.test(text),`${name}: literal shell wallet password in tracked runtime content`);
  check(!/process\.env\.WALLET_PASS\s*=\s*['"][^'"]+['"]/.test(text),`${name}: literal JavaScript wallet password in tracked runtime content`);
 }
}
execFileSync('git',['diff','--check'],{cwd:root,stdio:'pipe'});
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
else console.log(JSON.stringify({ok:true,markdownDocuments:docs.length,runtimeTestDoubleImports:0,mainnetClientConstructors:0,trackedPrivateState:0,absoluteLocalPaths:0,credentialShapes:0,scannedTextFiles,lockfileRootMatches:true}));
