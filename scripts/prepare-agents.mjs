#!/usr/bin/env node
/** Prepare an unfunded testnet authority. No signatures, transfers or paid x402 calls. */
import {readFile,writeFile,mkdir,access,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {parse} from 'yaml';
import {getAddress} from 'viem';import {privateKeyToAccount} from 'viem/accounts';
import {ensureWalletPass} from './load-wallet-pass.mjs';import {loadOperatorEnvironment} from './operator-env.mjs';
import {loadSealedGraphKey} from '../packages/gateway/src/analytics.ts';import {openSubgraphMcp} from '../packages/gateway/src/mcp.ts';
import {queryAgent0} from '../packages/gateway/src/reputation.ts';import {detailedAgentQuery,createAgentTools} from '../packages/gateway/src/agent-tools.ts';
import {seal} from '../packages/gateway/src/keyring.ts';import {digest} from '../packages/gateway/src/journal.ts';
import {VertexAgentModel} from '../packages/gateway/src/agent-model.ts';import {AGENT_TEMPLATES} from '../packages/gateway/src/agent-profiles.ts';
import {BLOCKY402_URL} from '../packages/gateway/src/facilitators.ts';
const root=resolve(new URL('..',import.meta.url).pathname),base=resolve(process.env.MANDATE_AGENT_STATE??join(root,'state/agents')),dataDir=join(base,'operator');
await mkdir(dataDir,{recursive:true,mode:0o700});
if(await access(join(dataDir,'agent-runtime.json')).then(()=>true,()=>false)){
 const c=JSON.parse(await readFile(join(dataDir,'agent-runtime.json'),'utf8'));
 console.log(JSON.stringify({status:'already_prepared',authorityId:c.authority.id,dataDir,expiresAt:new Date(c.authority.expiresAt).toISOString(),note:'No limits, keys or funding were changed. Start npm run agents:boot.'},null,2));process.exit(0);
}
await loadOperatorEnvironment(root);if(!await ensureWalletPass())throw new Error('Provision the Ledger Key Ring in the OS keychain first');
const key=await loadSealedGraphKey();if(!key)throw new Error('A sealed Graph credential is required');
const configured=parse(await readFile(join(root,'state/live/operator/active-mandate.yaml'),'utf8').catch(()=>''))??{};
const original=parse(await readFile(join(root,'mandate.yaml'),'utf8').catch(()=>''))??{};
const payer=getAddress(process.env.MANDATE_LEDGER_PAYER??configured.operatorAddress??'');
const receiver=getAddress(process.env.MANDATE_AGENT_RECEIVER??original.receiver??configured.receiver??'');
const mcp=await openSubgraphMcp(key);const failures=[];let agentSource,protocol;
const queries=[
 {id:'overview',description:'Indexed factory totals and metadata; use quality checks before relying on valuations.',query:'{ factories(first:1) { id poolCount txCount totalVolumeUSD totalValueLockedUSD } _meta { block { number } hasIndexingErrors } }'},
 {id:'activity',description:'Eight daily buckets of volume, fees, transactions and TVL. The newest day may be incomplete.',query:'{ uniswapDayDatas(first:8,orderBy:date,orderDirection:desc) { date volumeUSD feesUSD txCount tvlUSD } _meta { block { number } hasIndexingErrors } }'},
 {id:'pools',description:'Five pools with the largest indexed USD TVL, for investigating concentration and pricing anomalies.',query:'{ pools(first:5,orderBy:totalValueLockedUSD,orderDirection:desc) { id token0 { symbol } token1 { symbol } totalValueLockedUSD volumeUSD } _meta { block { number } hasIndexingErrors } }'},
];
try{
 const available=await mcp.listTools();const search=available.find(t=>t.name==='search_subgraphs_by_keyword'&&t.inputSchema?.properties?.keyword);
 if(!search)throw new Error('The live Graph MCP does not expose the supported discovery schema');
 const agents=JSON.parse(await mcp.callTool(search.name,{keyword:'Agent0'})).subgraphs??[];
 for(const candidate of agents.filter(s=>/base.*(testnet|sepolia)/i.test(s.metadata?.displayName??''))){
  try{const data=await queryAgent0(candidate.id,key,detailedAgentQuery(5));if(!Array.isArray(data.agents))throw new Error('No candidate collection');agentSource={provider:'the-graph',chain:'base-sepolia',deployment:candidate.id};break;}
  catch(e){failures.push({source:candidate.id,error:e.message});}
 }
 if(!agentSource)throw new Error('No query-verified Base Sepolia Agent0 source is available');
 const candidates=JSON.parse(await mcp.callTool(search.name,{keyword:'Uniswap V3'})).subgraphs??[];
 const preferred=candidates.filter(s=>/^Uniswap V3 (Base|Arbitrum|Optimism)$/.test(s.metadata?.displayName??''));
 preferred.sort((a,b)=>Number(b.metadata.displayName.endsWith('Base'))-Number(a.metadata.displayName.endsWith('Base')));
 for(const candidate of preferred.slice(0,4)){
  try{await Promise.all(queries.map(q=>queryAgent0(candidate.id,key,q.query)));protocol={id:candidate.metadata.displayName.toLowerCase().replaceAll(' ','-'),label:candidate.metadata.displayName,endpoint:`https://gateway.thegraph.com/api/x402/subgraphs/id/${candidate.id}`,queries};break;}
  catch(e){failures.push({source:candidate.id,error:e.message});}
 }
 if(!protocol)throw new Error('No query-verified protocol source is available');
}finally{await mcp.close();}
const hAccount=process.env.MANDATE_HEDERA_ACCOUNT_ID,hPayTo=process.env.SERVICE_PAY_TO;
if(!/^0\.0\.\d+$/.test(hAccount??'')||!/^0\.0\.\d+$/.test(hPayTo??'')||hAccount===hPayTo)throw new Error('Review distinct public Hedera payer and service account IDs');
const supported=await fetch(`${BLOCKY402_URL}/supported`,{redirect:'error',signal:AbortSignal.timeout(15000)}).then(r=>r.json());
const feePayer=supported.kinds?.find(k=>k.x402Version===2&&k.scheme==='exact'&&k.network==='hedera:testnet')?.extra?.feePayer;
if(!feePayer)throw new Error('Blocky402 has no live Hedera testnet fee payer');
for(const account of [hAccount,hPayTo]){
 const r=await fetch(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${account}/tokens?token.id=0.0.429274`,{signal:AbortSignal.timeout(15000),redirect:'error'});
 const body=await r.json();const token=body.tokens?.find(t=>t.token_id==='0.0.429274');
 if(!r.ok||!token||(account===hAccount&&BigInt(token.balance)<10000n))throw new Error(`Hedera account ${account} needs a USDC association and sufficient test balance`);
}
const vertex={project:process.env.GOOGLE_CLOUD_PROJECT??(await import('node:child_process')).execFileSync('gcloud',['config','get-value','project'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(),location:'global',model:process.env.MANDATE_VERTEX_MODEL??'gemini-3.5-flash'};
const probe=await new VertexAgentModel(vertex).next({run:{id:'setup-readiness',authorityId:'not-funded',agent:AGENT_TEMPLATES[0],goal:'No tools are configured. Finish with complete=false and state that no paid evidence was collected.',deadline:Date.now()+60000},tools:[],observations:[],failures:[],remainingBaseUnits:'0',remainingSteps:1},AbortSignal.timeout(60000));
const tools={agent0:{source:agentSource,detailed:true,endpoint:`https://gateway.thegraph.com/api/x402/subgraphs/id/${agentSource.deployment}`},protocols:[protocol],testnetEndpoints:{'graph-agent0':'http://127.0.0.1:8425/tools/graph-agent0','graph-protocol':'http://127.0.0.1:8425/tools/graph-protocol','crypto-prices':'http://127.0.0.1:8425/tools/crypto-prices','hedera-analysis':'http://127.0.0.1:8423/tools/hedera-analysis'}};
createAgentTools(tools);
const raw=randomBytes(32);let encrypted,spendingAddress;
try{spendingAddress=privateKeyToAccount(`0x${raw.toString('hex')}`).address;encrypted=await seal('mandate-session',raw);}finally{raw.fill(0);}
const id=`agent-${randomUUID()}`;
const authority={id,network:'eip155:84532',asset:'0x036CbD53842c5426634e7929541eC2318f3dCF7e',payerAddress:payer,spendingAddress,expiresAt:Date.now()+24*3600000,ceilingBaseUnits:'250000',perCallBaseUnits:'20000',windowBaseUnits:'100000',windowMs:3600000,
 tools:Object.entries(tools.testnetEndpoints).filter(([id])=>id!=='hedera-analysis').map(([id,url])=>({id,origin:new URL(url).origin,pathname:new URL(url).pathname,payTo:receiver})),
 hedera:{accountId:hAccount,payTo:hPayTo,feePayer,endpoint:tools.testnetEndpoints['hedera-analysis']},toolConfigurationHash:digest(tools)};
const config={version:1,vertex,authority,tools,rpcUrl:'https://sepolia.base.org',sealedKey:{file:'agent-spending.enc',ringKey:'mandate-session'},sealedHederaKey:{file:'agent-hedera.enc'},funding:{facilitatorUrl:'http://127.0.0.1:8426'}};
await writeFile(join(dataDir,'agent-spending.enc'),encrypted,{mode:0o600,flag:'wx'});
await copyFile(join(root,'secrets/hedera.enc'),join(dataDir,'agent-hedera.enc'));
await (await import('node:fs/promises')).chmod(join(dataDir,'agent-hedera.enc'),0o600);
await writeFile(join(dataDir,'agent-runtime.json'),JSON.stringify(config,null,2),{mode:0o600,flag:'wx'});
await writeFile(join(base,'setup-verification.json'),JSON.stringify({preparedAt:new Date().toISOString(),sourceVerification:{agent0:agentSource,protocol:{id:protocol.id,label:protocol.label},unavailableCandidates:failures},vertex:{...vertex,usage:probe.usage},hedera:{accountId:hAccount,payTo:hPayTo,feePayer},fundingPerformed:false},null,2),{mode:0o600});
console.log(JSON.stringify({status:'prepared_unfunded',authorityId:id,dataDir,spendingAddress,ceilingTestUSDC:'0.25',model:vertex.model,tools:Object.keys(tools.testnetEndpoints),next:'npm run agents:boot; review and approve testnet funding in the workspace. No payment was made by this setup.'},null,2));
