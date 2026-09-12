import {test} from 'node:test';import assert from 'node:assert/strict';
import {analyzeProtocolQuality,analyzeCandidateCoverage} from './agent-live-providers.ts';
import {createAgentTools} from './agent-tools.ts';
const endpoint='https://gateway.thegraph.com/api/x402/subgraphs/id/GqzP4Xaehti8KSfQmv3ZctFSjnSUYZ4En5NRsiTbvZpz';
const protocols=[{id:'uni-base',label:'Uniswap V3 Base',endpoint,queries:[{id:'overview',description:'Overview',query:'{ factories(first:1) { id } }'}]}];
test('quality service excludes partial UTC days and flags absurd upstream valuations instead of presenting them as reliable',()=>{
 const today=Date.UTC(2026,8,12)/1000;
 const result=analyzeProtocolQuality({overview:{factories:[{totalValueLockedUSD:'239193974184791822098445259215187600'}]},activity:{uniswapDayDatas:[{date:today,volumeUSD:'1'},{date:today-86400,volumeUSD:'200'},{date:today-172800,volumeUSD:'100'},{date:today-259200,volumeUSD:'100'},{date:today-345600,volumeUSD:'100'}]},pools:{pools:[]}},today*1000+3600000);
 assert.equal(result.latestCompleteDayVolumeUSD,'200');assert.equal(result.volumeChangePercent,100);assert.equal(result.valuationReliable,false);
 assert.ok((result.flags as string[]).some(f=>f.includes('incomplete')));
});
test('candidate review never converts repeated ratings or missing capability metadata into a trust score',()=>{
 const result=analyzeCandidateCoverage({agents:[{id:'8453:1',registrationFile:{name:'Example'},feedback:[{clientAddress:'0x1',value:'99',isRevoked:false},{clientAddress:'0x1',value:'1',isRevoked:false}],validations:[]}]},['8453:1','8453:2']);
 const candidate=(result.candidates as Array<Record<string,unknown>>)[0]!;
 assert.equal(candidate.distinctReviewers,1);assert.equal(candidate.automaticHiringSupported,false);assert.equal(candidate.paidSampleTestPerformed,false);
 assert.deepEqual(result.missingIds,['8453:2']);assert.ok((candidate.evidenceGaps as string[]).length>=4);
});
test('Hedera analysis tool cannot accept arbitrary URLs, extra instructions or non-observed-format IDs',()=>{
 const tool=createAgentTools({protocols,endpoints:{'hedera-analysis':'http://127.0.0.1:8423/tools/hedera-analysis'}})[0]!;
 assert.equal(tool.id,'hedera-analysis');
 assert.equal(tool.request({mode:'protocol-quality',sourceId:'uni-base'}).url,'http://127.0.0.1:8423/tools/hedera-analysis');
 assert.throws(()=>tool.request({mode:'protocol-quality',sourceId:'uni-base',url:'https://attacker.invalid'}),/unsupported/);
 assert.throws(()=>tool.request({mode:'candidate-check',sourceId:'agent0',agentIds:['1) { secret }']}),/observed/);
});
