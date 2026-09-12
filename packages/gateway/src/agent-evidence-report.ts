/** Deterministic specialist findings from observed fields; never invent causes or spend. */
import type {AgentRun} from './agent-store.ts';import type {ToolObservation} from './agent-runtime.ts';
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const rows=(value:unknown):Record<string,unknown>[]=>Array.isArray(value)?value.map(object):[];
const text=(value:unknown)=>String(value??'not available').replace(/[\r\n]+/g,' ').replace(/[<>]/g,'').replace(/[|*`\[\]]/g,'');
const number=(value:unknown)=>{if(value===null||value===undefined||value==='')return 'not available';const n=Number(value);if(!Number.isFinite(n))return 'not available';return Math.abs(n)>=1e15?n.toExponential(4):n.toLocaleString('en-US',{maximumFractionDigits:2});};
const provenance=(observations:ToolObservation[])=>{
 const sources=new Map<string,string>();for(const o of observations)for(const source of o.sources){try{const u=new URL(source.url);if(u.protocol==='https:'&&!u.username&&!u.password)sources.set(u.toString(),text(source.title));}catch{}}
 return ['## Sources','',...[...sources].map(([url,title])=>`- [${title}](${url.replace(/\)/g,'%29')})`)];
};
export function specialistEvidenceReport(run:AgentRun,observations:ToolObservation[]):string|undefined{
 const verified=observations.filter(o=>!o.error&&o.data!==null);
 const lab=verified.find(o=>o.toolId==='hedera-analysis');if(!lab)return undefined;const data=object(lab.data);
 if(data.rawSnapshots&&Array.isArray(data.flags)&&verified.some(o=>o.toolId==='graph-protocol')){
  const snapshots=object(data.rawSnapshots),factory=rows(object(snapshots.overview).factories)[0]??{},pools=rows(object(snapshots.pools).pools),source=object(data.source);
  const lines=[`# ${text(source.title??'Protocol')} investigation`,'',
   '## Conclusion','',
   data.valuationReliable===false?'The collected indexer data contains material valuation-quality warnings. It does not support treating the reported USD TVL as an independently verified economic value.':'The configured checks did not flag a valuation anomaly in this sample. That is not independent verification of reserves or prices.',
   '','## What the sources report','',
   '| Observation | Indexer-reported value |','| --- | --- |',
   `| Factory TVL | ${number(data.reportedAggregateTVLUSD)} USD |`,
   `| Pool count | ${number(factory.poolCount)} |`,
   `| Cumulative transaction count | ${number(factory.txCount)} |`,
   `| Latest complete UTC day | ${text(data.latestCompleteDay)} |`,
   `| Volume on that day | ${number(data.latestCompleteDayVolumeUSD)} USD |`,
   `| Mean daily volume in the ${number(data.comparisonDays)} preceding sampled complete days | ${number(data.priorMeanDailyVolumeUSD)} USD |`,
   `| Change against that mean | ${number(data.volumeChangePercent)}% |`,'',
   'These are reported indexed values, not independently priced reserves or confirmed economic activity. USD volume estimates may also be affected when the source has pricing-quality problems. The latest incomplete UTC-day bucket is excluded by the analysis method.','',
   '## Quality checks','',...(data.flags as unknown[]).filter(f=>typeof f==='string').map(f=>`- ${text(f)}`),
   '','## Sampled pool valuations','',
   '| Indexed pool | Reported TVL (USD) |','| --- | --- |',
   ...pools.slice(0,5).map(p=>`| ${text(object(p.token0).symbol)} / ${text(object(p.token1).symbol)} | ${number(p.totalValueLockedUSD)} |`),
   '','The factory, daily and pool queries are separate snapshots. A sampled pool exceeding the reported factory aggregate is a consistency warning to investigate, not proof of a particular pricing bug or an atomic same-block contradiction.','',
   '## What remains unknown','',
   'The collected evidence does not establish the cause of the extreme valuations, the true USD value of reserves, or the cause of the reported volume change. Pricing and indexing errors are possible explanations, not confirmed diagnoses. Independent native reserve and token-pricing evidence was not collected. That is a coverage limitation; it is not proof that the spending allowance was exhausted.',
  ];
  const market=verified.find(o=>o.toolId==='crypto-prices'),quotes=rows(object(market?.data).quotes);
  if(quotes.length)lines.push('','## Reference spot observations','',...quotes.map(q=>`- ${text(q.symbol)}: ${number(q.amount)} ${text(q.currency)}`),'','These are point-in-time reference quotes. They do not establish price stability or validate the valuations of unrelated pool tokens.');
  lines.push('','## Evidence and payment boundary','',`${verified.length} retained paid observations informed this report. The Evidence Lab analysis was purchased through native Hedera testnet; other receipts retain their own settlement network. Exact costs and transfer evidence are displayed separately from this factual summary. No new service was called to format this report.`,'',...provenance(verified));
  return lines.join('\n');
 }
 if(Array.isArray(data.candidates)&&verified.some(o=>o.toolId==='graph-agent0')){
  const candidates=rows(data.candidates),lines=['# Agent candidate evidence review','','## Decision boundary','',
   'These observations support a bounded comparison of indexed candidates, not a verified hiring recommendation. Declared x402 support and feedback are not substitutes for a successful, authorized job-specific service test. No candidate endpoint was independently invoked by this evidence service.','',
   '| Candidate | Declared x402 support | Distinct reviewers in sample | Sampled validation records |','| --- | --- | --- | --- |',
   ...candidates.map(c=>`| ${text(c.name)} (${text(c.id)}) | ${c.declaredX402Support===true?'Advertised':c.declaredX402Support===false?'Not advertised':'Not recorded'} | ${number(c.distinctReviewers)} | ${rows(c.validationRecords).length} |`),
   '','## Candidate-specific evidence gaps',''];
  for(const candidate of candidates)lines.push(`### ${text(candidate.name??candidate.id)}`,'',...(Array.isArray(candidate.evidenceGaps)?candidate.evidenceGaps:[]).map(g=>`- ${text(g)}`),'');
  lines.push('## Limitations','','A missing registry field does not prove that a service does not exist. This is a bounded registry/feedback sample, not a complete marketplace search. Heterogeneous feedback values were not averaged into a fabricated trust score. Candidate suitability still requires a reviewed endpoint, price and job-specific sample result.','',...provenance(verified));
  return lines.join('\n');
 }
 return undefined;
}
