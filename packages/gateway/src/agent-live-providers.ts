/** First-party mainnet x402 services backed by live data, with explicit provenance. */
import { createAgentTools, type AgentToolConfiguration, type GraphToolSource } from "./agent-tools.ts";
import { queryAgent0 } from "./reputation.ts";
import type { PaidAgentProvider } from "./agent-tool-service.ts";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.slice(0,100).map(record) : [];
const numeric = (value: unknown): number | null => { const n = Number(value); return value !== null && value !== undefined && value !== "" && Number.isFinite(n) ? n : null; };
const sourceUrl = (id: string) => `https://gateway.thegraph.com/api/subgraphs/id/${id}`;
function deployment(source: GraphToolSource): string {
  const id = new URL(source.endpoint).pathname.split("/").at(-1)!;
  if (!/^[A-Za-z0-9]{40,50}$/.test(id)) throw new Error("Invalid reviewed Graph source");
  return id;
}
export function analyzeProtocolQuality(data: { overview: unknown; activity: unknown; pools: unknown }, now = Date.now()): Record<string, unknown> {
  const today = Math.floor(now / 86400000) * 86400;
  const days = rows(record(data.activity).uniswapDayDatas).sort((a,b) => Number(b.date) - Number(a.date));
  const completeDays = days.filter(d => Number(d.date) < today && Number(d.date) > 0);
  const latest = completeDays[0], prior = completeDays.slice(1,7);
  const latestVolume = numeric(latest?.volumeUSD);
  const baselineValues = prior.map(d => numeric(d.volumeUSD)).filter((n): n is number => n !== null && n >= 0);
  const baseline = baselineValues.length ? baselineValues.reduce((a,b) => a+b,0) / baselineValues.length : null;
  const factory = rows(record(data.overview).factories)[0];
  const tvl = numeric(factory?.totalValueLockedUSD);
  const pools = rows(record(data.pools).pools);
  const flags: string[] = [];
  if (days.some(d => Number(d.date) >= today)) flags.push("The newest daily bucket is incomplete; trend calculations exclude it.");
  if (tvl !== null && (tvl < 0 || tvl > 1e15)) flags.push("Reported aggregate USD valuation exceeds the declared sanity threshold of 1 quadrillion USD; treat valuation and TVL-derived ratios as unreliable, not as verified economic value.");
  if (pools.some(p => (numeric(p.totalValueLockedUSD) ?? 0) > 1e15)) flags.push("At least one sampled pool has an extreme USD valuation. Investigate token pricing and indexing before making a TVL claim.");
  if (baselineValues.length < 3) flags.push("Too few complete daily observations for a stable comparison.");
  const poolSum = pools.reduce((sum,p) => sum + (numeric(p.totalValueLockedUSD) ?? 0),0);
  if (tvl !== null && poolSum > tvl * 1.01) flags.push("The sampled pool valuations exceed the reported aggregate. Snapshots may be at different blocks; the inconsistency needs investigation.");
  const indexingErrors = Object.values(data).some(d => record(record(d)._meta).hasIndexingErrors === true);
  if (indexingErrors) flags.push("The Graph reports indexing errors for at least one snapshot.");
  return {
    methodology: "Compare the most recent complete UTC day with up to six earlier complete days. Check valuation outliers and cross-query consistency. These are transparent heuristics, not a risk score or a causal explanation.",
    latestCompleteDay: latest ? new Date(Number(latest.date)*1000).toISOString().slice(0,10) : null,
    latestCompleteDayVolumeUSD: latest?.volumeUSD ?? null,
    comparisonDays: baselineValues.length,
    priorMeanDailyVolumeUSD: baseline,
    volumeChangePercent: latestVolume !== null && baseline !== null && baseline > 0 ? (latestVolume/baseline-1)*100 : null,
    reportedAggregateTVLUSD: factory?.totalValueLockedUSD ?? null,
    valuationReliable: tvl !== null && tvl >= 0 && tvl <= 1e15 && !flags.some(f => /valuation|exceed|indexing/i.test(f)),
    flags,
    limitations: ["USD valuations are upstream indexed estimates, not independently priced reserves.", "Feedback from this service does not authorize spending.", "Separate Graph queries are not an atomic cross-query snapshot.", "Read-only source-chain data and Base mainnet payment settlement are distinct."],
    rawSnapshots: data,
  };
}
export function analyzeCandidateCoverage(data: unknown, requestedIds: string[]): Record<string, unknown> {
  const agents = rows(record(data).agents);
  const candidates = agents.map(agent => {
    const registration = record(agent.registrationFile), feedback = rows(agent.feedback), validations = rows(agent.validations);
    const active = feedback.filter(f => f.isRevoked === false);
    const uniqueReviewers = new Set(active.map(f => String(f.clientAddress ?? "")).filter(Boolean));
    const gaps: string[] = [];
    if (!registration.description) gaps.push("No indexed capability description.");
    if (registration.active !== true) gaps.push("Registration does not explicitly establish active operation.");
    if (registration.x402Support !== true) gaps.push("Registration does not explicitly advertise x402 support.");
    if (![registration.mcpEndpoint,registration.a2aEndpoint,registration.webEndpoint].some(Boolean)) gaps.push("No usable service endpoint is present in the reviewed registration fields.");
    if (uniqueReviewers.size < 2) gaps.push("Fewer than two distinct reviewers appear in this bounded sample.");
    if (!validations.length) gaps.push("No validation records appear in the bounded sample.");
    return { id: agent.id, name: registration.name ?? null, wallet: agent.agentWallet ?? null,
      declaredCapabilities: registration.description ?? null, declaredX402Support: registration.x402Support ?? null,
      declaredEndpoints: { mcp: registration.mcpEndpoint ?? null, a2a: registration.a2aEndpoint ?? null, web: registration.webEndpoint ?? null },
      feedbackSampleSize: feedback.length, activeFeedbackSampleSize: active.length, distinctReviewers: uniqueReviewers.size,
      revokedFeedbackCount: feedback.filter(f => f.isRevoked === true).length,
      validationRecords: validations, evidenceGaps: gaps, paidSampleTestPerformed: false,
      automaticHiringSupported: false };
  });
  return { methodology: "Review only the selected onchain IDs. Compare declared capabilities, sampled reviewer diversity, revocations and validation coverage. Heterogeneous feedback values are never averaged into a trust score.",
    candidates, missingIds: requestedIds.filter(id => !agents.some(a => a.id === id)),
    limitations: ["No candidate endpoint was invoked or independently tested.", "Indexed registrations can be incomplete; absence of metadata is not proof that a service does not exist.", "No automatic hiring recommendation is justified without verifying the job-specific service."],
    sourceMetadata: record(data)._meta ?? null, rawEvidence: data };
}
export function createLiveAgentProviders(input: {
  tools: AgentToolConfiguration; graphKey: () => Promise<string | null>; fetch?: typeof fetch;
}): { evm: PaidAgentProvider[]; hedera: PaidAgentProvider[] } {
  const catalog = createAgentTools(input.tools), transport = input.fetch ?? fetch;
  const definition = (id: string) => { const tool = catalog.find(t => t.id === id); if (!tool) throw new Error(`Tool ${id} is not configured`); return tool; };
  const graph = async (id: string, query: string, signal: AbortSignal) => {
    signal.throwIfAborted(); const key = await input.graphKey();
    if (!key) throw new Error("The live Graph provider has no sealed API credential");
    const fetchFn: typeof fetch = (url, init) => transport(url,{...init,signal:AbortSignal.any([signal,init?.signal ?? AbortSignal.timeout(15000)])});
    return queryAgent0(id,key,query,undefined,fetchFn);
  };
  const provenance = (id: string, title: string) => ({ provider: "the-graph", deployment: id, title, url: sourceUrl(id) });
  const evm: PaidAgentProvider[] = [];
  if (input.tools.agent0 && catalog.some(t => t.id === "graph-agent0")) {
    const config = input.tools.agent0;
    const plain = createAgentTools({ agent0: config }).find(t => t.id === "graph-agent0")!;
    evm.push({ id:"graph-agent0",description:"Live Agent0 candidate discovery with indexed registration metadata and bounded feedback.",amountBaseUnits:"1000",
      validate(value){plain.request(value);}, async execute(value,signal){
        const request = plain.request(value), query = JSON.parse(request.body!).query;
        const data = await graph(config.source.deployment,query,signal);
        return { data, source: { ...provenance(config.source.deployment,`Agent0 on ${config.source.chain}`), dataNetwork:config.source.chain },
          observedAt:new Date().toISOString(), selection:"A bounded sample of registrations with indexed metadata, ordered by feedback count. This is discovery, not a quality ranking.",
          caveat:"Declared capabilities and endpoints have not been independently tested." };
      } });
  }
  if (input.tools.protocols?.length && catalog.some(t => t.id === "graph-protocol")) {
    const plain = createAgentTools({protocols:input.tools.protocols}).find(t => t.id === "graph-protocol")!;
    evm.push({id:"graph-protocol",description:"Live, schema-verified protocol snapshots from The Graph. Source-chain reads do not move mainnet funds.",amountBaseUnits:"1000",
      validate(value){plain.request(value);},async execute(value,signal){
        const source=input.tools.protocols!.find(s=>s.id===value.sourceId)!, query=source.queries.find(q=>q.id===value.queryId)!;
        const data=await graph(deployment(source),query.query,signal);
        return {data,source:provenance(deployment(source),source.label),queryId:query.id,observedAt:new Date().toISOString(),
          caveat:"Indexed values can contain pricing or data-quality anomalies. Do not equate a successful query with a reliable valuation."};
      }});
  }
  if(catalog.some(t=>t.id==="crypto-prices")) evm.push({id:"crypto-prices",description:"Fresh public Coinbase spot-price observations for BTC, ETH or SOL; sold by Mandate for mainnet USDC.",amountBaseUnits:"1000",
    validate(value){definition("crypto-prices").request(value);if((value.coins as string[]).some(c=>!["BTC","ETH","SOL"].includes(c)))throw new Error("The live market provider supports BTC, ETH and SOL only");},
    async execute(value,signal){
      const quotes=await Promise.all((value.coins as string[]).map(async coin=>{
        const url=`https://api.coinbase.com/v2/prices/${coin}-USD/spot`;
        const response=await transport(url,{redirect:"error",signal:AbortSignal.any([signal,AbortSignal.timeout(12000)])});
        if(!response.ok)throw new Error(`Market provider unavailable (HTTP ${response.status})`);
        const body=await response.json() as {data?:{amount?:string;base?:string;currency?:string}};
        if(body.data?.base!==coin||body.data.currency!=="USD"||!body.data.amount||!/^\d+(\.\d+)?$/.test(body.data.amount))throw new Error("Market provider returned an invalid quote");
        return {symbol:coin,amount:body.data.amount,currency:"USD",url,title:`Coinbase ${coin}/USD spot observation`};
      }));
      return {quotes,observedAt:new Date().toISOString(),underlyingProvider:"Coinbase public spot API",caveat:"A point-in-time market quote does not explain protocol activity. Coinbase is not accepting this mainnet x402 payment; Mandate is the paid service."};
    }});
  const hedera:PaidAgentProvider[]=[];
  if(catalog.some(t=>t.id==="hedera-analysis")) hedera.push({id:"hedera-analysis",description:"Evidence Lab: fresh Graph-backed data-quality and candidate-coverage investigations, paid through the reviewed Base mainnet service.",amountBaseUnits:"2000",
    validate(value){definition("hedera-analysis").request(value);},async execute(value,signal){
      if(value.mode==="protocol-quality"){
        const source=input.tools.protocols!.find(s=>s.id===value.sourceId)!;
        const values=await Promise.all(["overview","activity","pools"].map(async id=>{
          const query=source.queries.find(q=>q.id===id);if(!query)throw new Error("Protocol does not have a verified evidence-quality query set");
          return [id,await graph(deployment(source),query.query,signal)] as const;
        }));
        const data=Object.fromEntries(values) as {overview:unknown;activity:unknown;pools:unknown};
        return {...analyzeProtocolQuality(data),source:provenance(deployment(source),source.label),observedAt:new Date().toISOString()};
      }
      const config=input.tools.agent0!, ids=value.agentIds as string[];
      const query=`{ agents(first:5,where:{id_in:${JSON.stringify(ids)}}) { id agentWallet totalFeedback registrationFile { name description active x402Support mcpEndpoint a2aEndpoint webEndpoint } feedback(first:20,orderBy:createdAt,orderDirection:desc) { value isRevoked clientAddress tag1 tag2 } validations(first:10) { response status validatorAddress } } _meta { block {number} hasIndexingErrors } }`;
      const data=await graph(config.source.deployment,query,signal);
      return {...analyzeCandidateCoverage(data,ids),source:provenance(config.source.deployment,`Agent0 on ${config.source.chain}`),observedAt:new Date().toISOString()};
    }});
  return {evm,hedera};
}
