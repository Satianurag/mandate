/** Prepare a new mainnet authority. Drafts contain public configuration only; no payment is sent. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {createPublicClient,http,getAddress} from 'viem';
import {HTTPFacilitatorClient,decodePaymentRequiredHeader} from '@x402/core/http';
import {createAgentTools,type AgentToolConfiguration} from './agent-tools.ts';
import {validateVertexConfig,type VertexAgentConfig} from './agent-model.ts';
import {EXACT_USDC,validateExactAuthority} from './agent-exact.ts';
import {seal,withSecret} from './keyring.ts';
import {digest,units} from './journal.ts';
import type {AgentRuntimeConfiguration} from './agent-services.ts';
import {AGENT_TOOL_IDS,type AgentToolId} from './agent-profiles.ts';
import {LOCAL_TOOL_ORIGIN,localToolUrl} from './agent-local-tools.ts';
import {DEFAULT_FACILITATOR_URL} from './facilitators.ts';
import {resolveMainnetGraphSources} from './mainnet-graph.ts';
import {validateHederaScope} from './agent-hedera.ts';
export interface SetupDraft {
 vertex:VertexAgentConfig; payerAddress:string; rpcUrl:string; facilitatorUrl:string;
 ceilingBaseUnits:string;perCallBaseUnits:string;windowBaseUnits:string;windowMs:number;durationHours:number;ringKey:string;
 toolIds:AgentToolId[];
}
export const DEFAULT_SETUP:SetupDraft={vertex:{project:'',location:'global',model:'gemini-3.5-flash'},payerAddress:'',rpcUrl:'https://mainnet.base.org',facilitatorUrl:DEFAULT_FACILITATOR_URL,ceilingBaseUnits:'250000',perCallBaseUnits:'20000',windowBaseUnits:'100000',windowMs:3600000,durationHours:24,ringKey:'mandate-session',toolIds:['graph-agent0','graph-protocol','hedera-analysis','crypto-prices']};
/** Tools served on loopback :8425 by Mandate (Graph-backed or Coinbase spot). */
export const LOCAL_TOOL_IDS=new Set<AgentToolId>(['graph-agent0','graph-protocol','hedera-analysis','crypto-prices']);
const GRAPH_LOCAL=new Set<AgentToolId>(['graph-agent0','graph-protocol','hedera-analysis']);
export function resolveFacilitatorUrl(d:SetupDraft):string{
 return d.facilitatorUrl?.trim()?reviewedFacilitator(d.facilitatorUrl):DEFAULT_FACILITATOR_URL;
}
const supportedTools=AGENT_TOOL_IDS;
function https(value:unknown,label:string):string {
 if(typeof value!=='string')throw new Error(`${label} is required`);const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error(`${label} requires HTTPS without embedded credentials`);
 return url.toString().replace(/\/$/,'');
}
/** Same rule as funding: public HTTPS, or the self-hosted loopback facilitator. */
function reviewedFacilitator(value:unknown):string {
 if(typeof value!=='string')throw new Error('Facilitator is required');const url=new URL(value);
 if(!(url.protocol==='https:'||url.protocol==='http:'&&url.hostname==='127.0.0.1')||url.username||url.password||url.search||url.hash)throw new Error('Facilitator must be HTTPS or loopback HTTP without credentials');
 return url.toString().replace(/\/$/,'');
}
export async function readSetupDraft(dir:string):Promise<SetupDraft>{
 try{return JSON.parse(await readFile(join(dir,'setup-draft.json'),'utf8')) as SetupDraft;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;const draft=structuredClone(DEFAULT_SETUP);
  try { const result=await promisify(execFile)('gcloud',['config','get-value','project'],{timeout:10000,maxBuffer:16384});const project=result.stdout.trim();validateVertexConfig({...draft.vertex,project});draft.vertex.project=project; } catch { /* User can supply the project in Settings. */ }
  return draft;}
}
export async function saveSetupDraft(dir:string,input:unknown):Promise<SetupDraft>{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Setup must be an object');
 const d=input as SetupDraft;
 if(Object.keys(d).some(k=>!Object.hasOwn(DEFAULT_SETUP,k)))throw new Error('Unknown setup field');
 if(!d.vertex||typeof d.vertex.project!=='string'||typeof d.vertex.location!=='string'||typeof d.vertex.model!=='string')throw new Error('Model settings are required');
 if(d.vertex.project)validateVertexConfig({...d.vertex});
 if(d.payerAddress)getAddress(d.payerAddress);
 https(d.rpcUrl,'RPC');if(d.facilitatorUrl?.trim())reviewedFacilitator(d.facilitatorUrl);
 if(units(d.ceilingBaseUnits,true)>5000000n||units(d.perCallBaseUnits,true)>units(d.ceilingBaseUnits)||units(d.windowBaseUnits,true)>units(d.ceilingBaseUnits))throw new Error('Use a budget up to 5 USDC and limits no larger than that budget');
 if(!Number.isInteger(d.windowMs)||d.windowMs<60000||d.windowMs>86400000||!Number.isInteger(d.durationHours)||d.durationHours<1||d.durationHours>168)throw new Error('Use a 1 minute–24 hour rolling window and 1–168 hour expiry');
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(d.ringKey))throw new Error('Choose an existing Ledger Key Ring key');
 if(!Array.isArray(d.toolIds)||!d.toolIds.length||d.toolIds.some(id=>!supportedTools.includes(id as typeof supportedTools[number]))||new Set(d.toolIds).size!==d.toolIds.length)throw new Error('Select supported services');
 const value=structuredClone(d);await writeFile(join(dir,'setup-draft.tmp'),JSON.stringify(value,null,2),{mode:0o600});await rename(join(dir,'setup-draft.tmp'),join(dir,'setup-draft.json'));return value;
}
const samples:Record<string,Record<string,unknown>>={'web-search':{query:'x402 payment protocol official documentation',numResults:1},'crypto-news':{},'crypto-prices':{coins:['BTC']}};
export async function inspectSetup(d:SetupDraft){
 validateVertexConfig({...d.vertex});
 const rpc=createPublicClient({transport:http(https(d.rpcUrl,'RPC'),{timeout:12000,retryCount:0})});
 if(await rpc.getChainId()!==8453)throw new Error('The RPC must report Base mainnet chain 8453');
 const facilitatorUrl=resolveFacilitatorUrl(d);
 const facilitator=new HTTPFacilitatorClient({url:facilitatorUrl});
 if(!(await facilitator.getSupported()).kinds.some(k=>k.x402Version===2&&k.scheme==='exact'&&k.network==='eip155:8453'))throw new Error('The facilitator must support exact USDC on Base mainnet');
 const vendorIds=d.toolIds.filter(id=>!LOCAL_TOOL_IDS.has(id));
 const catalog=createAgentTools().filter(t=>vendorIds.includes(t.id));
 const services=await Promise.all(catalog.map(async tool=>{
  const request=tool.request(samples[tool.id]!);const response=await fetch(request.url,{method:request.method,body:request.body,headers:request.body?{'content-type':'application/json'}:{},redirect:'error',signal:AbortSignal.timeout(15000)});
  const header=response.headers.get('payment-required');await response.body?.cancel();
  if(response.status!==402||!header)throw new Error(`${tool.id} did not return an unpaid x402 offer (HTTP ${response.status})`);
  const offer=decodePaymentRequiredHeader(header).accepts.find(o=>o.network==='eip155:8453'&&o.scheme==='exact'&&getAddress(o.asset)===getAddress(EXACT_USDC['eip155:8453'])&&o.extra?.name==='USD Coin'&&o.extra?.version==='2');
  if(!offer)throw new Error(`${tool.id} has no supported Base mainnet USDC offer`);
  if(units(offer.amount,true)>units(d.perCallBaseUnits))throw new Error(`${tool.id} price exceeds your per-call limit`);
  const url=new URL(request.url);return{id:tool.id,origin:url.origin,pathname:url.pathname,payTo:getAddress(offer.payTo),amountBaseUnits:offer.amount};
 }));
 const local=d.toolIds.filter(id=>LOCAL_TOOL_IDS.has(id)).map(id=>({id,origin:LOCAL_TOOL_ORIGIN,pathname:`/tools/${id}`,payTo:'pending',amountBaseUnits:id==='hedera-analysis'?'2000':'1000'}));
 return{services:[...services,...local],network:'eip155:8453',checkedAt:Date.now(),paymentMade:false};
}
export async function prepareSetup(dir:string,d:SetupDraft){
 const payer=getAddress(d.payerAddress);const inspected=await inspectSetup(d);
 const loader=await import(new URL('../../../scripts/load-wallet-pass.mjs',import.meta.url).href) as {ensureWalletPass:()=>Promise<string>};
 if(!await loader.ensureWalletPass())throw new Error('Unlock your provisioned Ledger Key Ring in the OS keychain before preparing a spending wallet');
 const secret=Buffer.from(generatePrivateKey().slice(2),'hex');const id='mainnet-'+randomUUID();const keyFile=id+'.enc';
 try{
  const account=privateKeyToAccount(`0x${secret.toString('hex')}`);const ciphertext=await seal(d.ringKey,secret);
  await withSecret(d.ringKey,ciphertext,async recovered=>{if(!recovered.equals(secret))throw new Error('Key Ring round-trip verification failed');});
  const localToolIds=d.toolIds.filter(id=>LOCAL_TOOL_IDS.has(id));
  const tools:AgentToolConfiguration={};
  if(localToolIds.length){
   if(localToolIds.some(id=>GRAPH_LOCAL.has(id))){
    const graph=await resolveMainnetGraphSources();
    if(localToolIds.includes('graph-agent0')){
     if(!graph.agent0)throw new Error('Agent0 on Base was not discovered. Seal a Graph API key as secrets/graph.enc and retry.');
     tools.agent0=graph.agent0;
    }
    if(localToolIds.includes('graph-protocol')||localToolIds.includes('hedera-analysis')){
     if(!graph.protocols?.length)throw new Error('Uniswap V3 Base was not discovered. Set MANDATE_UNISWAP_V3_BASE_SUBGRAPH or retry Graph discovery.');
     tools.protocols=graph.protocols;
    }
   }
   tools.endpoints=Object.fromEntries(localToolIds.map(id=>[id,localToolUrl(id)]));
  }
  const vendor=inspected.services.filter(s=>!LOCAL_TOOL_IDS.has(s.id as AgentToolId)).map(({amountBaseUnits,...scope})=>scope);
  const local=localToolIds.map(id=>({id,origin:LOCAL_TOOL_ORIGIN,pathname:`/tools/${id}`,payTo:account.address}));
  const hederaAccount=process.env.MANDATE_HEDERA_ACCOUNT_ID?.trim();
  const hederaPayTo=process.env.MANDATE_HEDERA_PAY_TO?.trim();
  const hederaFeePayer=process.env.MANDATE_HEDERA_FEE_PAYER?.trim();
  const hedera=localToolIds.includes('hedera-analysis')&&hederaAccount&&hederaPayTo&&hederaFeePayer
   ?validateHederaScope({accountId:hederaAccount,payTo:hederaPayTo,feePayer:hederaFeePayer,endpoint:localToolUrl('hedera-analysis')})
   :undefined;
  const authority=validateExactAuthority({id,network:'eip155:8453',asset:EXACT_USDC['eip155:8453'],payerAddress:payer,spendingAddress:account.address,expiresAt:Date.now()+d.durationHours*3600000,ceilingBaseUnits:d.ceilingBaseUnits,perCallBaseUnits:d.perCallBaseUnits,windowBaseUnits:d.windowBaseUnits,windowMs:d.windowMs,toolConfigurationHash:digest(tools),tools:[...vendor,...local],hedera});
  const config:AgentRuntimeConfiguration={version:1,vertex:validateVertexConfig({...d.vertex}),authority,tools,rpcUrl:d.rpcUrl,sealedKey:{file:keyFile,ringKey:d.ringKey},funding:{facilitatorUrl:resolveFacilitatorUrl(d)},
   ...(process.env.MANDATE_HEDERA_KEY_ENC?{sealedHederaKey:{file:process.env.MANDATE_HEDERA_KEY_ENC}}:{})};
  await writeFile(join(dir,keyFile),ciphertext,{mode:0o600,flag:'wx'});
  try{await writeFile(join(dir,'agent-runtime.tmp'),JSON.stringify(config,null,2),{mode:0o600});await rename(join(dir,'agent-runtime.tmp'),join(dir,'agent-runtime.json'));}catch(e){await unlink(join(dir,keyFile));throw e;}
  return {authority,inspected,paymentMade:false};
 }finally{secret.fill(0);}
}
