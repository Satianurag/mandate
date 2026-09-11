#!/usr/bin/env node
/** Official descriptor lint is separate from runtime display evidence. Never turn missing tooling into success. */
import {readdir,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
const root=new URL('..',import.meta.url).pathname;
const descriptors=(await readdir(join(root,'docs/erc7730'))).filter(name=>name.endsWith('.json')).map(name=>join(root,'docs/erc7730',name));
if(!descriptors.length)throw new Error('No current descriptor files exist');
const executable=process.env.ERC7730_BIN??(existsSync(join(root,'.venv/bin/erc7730'))?join(root,'.venv/bin/erc7730'):'erc7730');
const schemaOnly=process.argv.includes('--schema-only');
const args=['lint',...(schemaOnly?['--skip-abi-validation']:[]),...descriptors];
const result=spawnSync(executable,args,{cwd:root,encoding:'utf8',timeout:60000});
const report={checkedAt:new Date().toISOString(),status:result.error?.code==='ENOENT'?'tooling_unavailable':result.status===0?(schemaOnly?'schema_only':'full_lint_passed'):'failed',
 abiValidation:!schemaOnly,descriptorFiles:descriptors.map(file=>file.slice(root.length)),
 runtimeDeviceDisplayVerified:false,registryAcceptanceVerified:false,output:`${result.stdout??''}${result.stderr??''}`.slice(-12000)};
await mkdir(join(root,'.live-results/repair'),{recursive:true});
await writeFile(join(root,'.live-results/repair/erc7730-lint.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(report.status==='tooling_unavailable')process.exitCode=2;
else if(result.status!==0)process.exitCode=1;
