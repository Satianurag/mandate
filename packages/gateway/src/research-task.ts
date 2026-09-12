/** Versioned, deterministic research intent and evidence brief. */

export const RESEARCH_TEMPLATE = "agent0-due-diligence" as const;
export const RESEARCH_PURPOSE = "Compare Agent0 service registrations using paid registry evidence";
export const RESEARCH_CHAINS = ["base", "ethereum", "bsc", "polygon", "monad"] as const;
export type ResearchChain = typeof RESEARCH_CHAINS[number];

export interface ResearchSourceScope {
  provider: "the-graph";
  chain: ResearchChain;
  deployment: string;
}

export interface ResearchTaskSpecV1 {
  version: 1;
  template: typeof RESEARCH_TEMPLATE;
  source: ResearchSourceScope;
  maxResults: number;
}

export interface ResearchAccounting {
  requestId: string;
  paidCalls: number;
  acceptedCostBaseUnits: string;
  reservedBaseUnits: string;
  remainingAuthorityBaseUnits: string;
  ceilingBaseUnits: string;
  completedAt: string;
}

export interface ResearchEvidenceRow {
  id?: unknown;
  agentId?: unknown;
  agentWallet?: unknown;
  totalFeedback?: unknown;
  measurements?: unknown;
}

export interface ResearchPayload {
  source?: unknown;
  sourceMetadata?: unknown;
  observedAt?: unknown;
  rows?: unknown;
  paid?: unknown;
  [key: string]: unknown;
}

const DEPLOYMENT_RE = /^[A-Za-z0-9]{40,50}$/;

function exactObject(value: unknown, fields: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const extras = Object.keys(record).filter(key => !fields.includes(key));
  if (extras.length) throw new Error(`${label} contains unsupported field ${JSON.stringify(extras[0])}`);
  return record;
}

export function validateResearchSource(value: unknown): ResearchSourceScope {
  const source = exactObject(value, ["provider", "chain", "deployment"], "Research source");
  if (source.provider !== "the-graph") throw new Error("Research source provider must be the-graph");
  if (!RESEARCH_CHAINS.includes(source.chain as ResearchChain)) throw new Error("Research source must be a supported Agent0 network");
  if (typeof source.deployment !== "string" || !DEPLOYMENT_RE.test(source.deployment)) throw new Error("Research deployment must be an exact discovered subgraph ID");
  return Object.freeze({ provider: "the-graph", chain: source.chain as ResearchChain, deployment: source.deployment });
}

export function sameResearchSource(a: ResearchSourceScope, b: ResearchSourceScope): boolean {
  return a.provider === b.provider && a.chain === b.chain && a.deployment === b.deployment;
}

export function assessResearchSource(
  source: ResearchSourceScope,
  discovered: Record<string, string>,
): {
  ok: boolean;
  status: "available" | "unavailable" | "deployment_changed";
  source: ResearchSourceScope;
  discoveredDeployment: string | null;
  fallbackAllowed: false;
} {
  const discoveredDeployment = discovered[source.chain] ?? null;
  return {
    ok: discoveredDeployment === source.deployment,
    status: discoveredDeployment === null ? "unavailable" : discoveredDeployment === source.deployment ? "available" : "deployment_changed",
    source,
    discoveredDeployment,
    fallbackAllowed: false,
  };
}

export function normalizeResearchTask(value: unknown, expectedSource: ResearchSourceScope): ResearchTaskSpecV1 {
  const task = exactObject(value, ["version", "template", "source", "maxResults"], "Research task");
  if (task.version !== 1) throw new Error("Research task version must be 1");
  if (task.template !== RESEARCH_TEMPLATE) throw new Error("Research task template is not allowed by this product");
  const source = validateResearchSource(task.source);
  if (!sameResearchSource(source, expectedSource)) throw new Error("Research task source is outside the reviewed mandate");
  if (!Number.isSafeInteger(task.maxResults) || Number(task.maxResults) < 2 || Number(task.maxResults) > 10) {
    throw new Error("Research task maxResults must be an integer from 2 to 10");
  }
  return Object.freeze({ version: 1, template: RESEARCH_TEMPLATE, source, maxResults: Number(task.maxResults) });
}

export function compileResearchQuery(task: ResearchTaskSpecV1): string {
  return `query Agent0DueDiligence {\n  agents(first: ${task.maxResults}, orderBy: totalFeedback, orderDirection: desc) {\n    id\n    agentId\n    agentWallet\n    totalFeedback\n    feedback(first: 8, orderBy: createdAt, orderDirection: desc) {\n      value\n      isRevoked\n    }\n  }\n  _meta { block { number } }\n}`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function unsignedOrNull(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

function measurements(value: unknown): Array<{ value: string; isRevoked: boolean }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.value !== "string" || typeof record.isRevoked !== "boolean") return [];
    return [{ value: record.value, isRevoked: record.isRevoked }];
  });
}

function sourceBlock(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const block = (value as { block?: unknown }).block;
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const number = (block as { number?: unknown }).number;
  if (typeof number === "number" && Number.isSafeInteger(number) && number >= 0) return String(number);
  if (typeof number === "string" && /^(0|[1-9][0-9]*)$/.test(number)) return number;
  return null;
}

export function buildDueDiligenceBrief(task: ResearchTaskSpecV1, payload: ResearchPayload, accounting: ResearchAccounting) {
  const rawRows = Array.isArray(payload.rows) ? payload.rows.slice(0, task.maxResults) : [];
  const candidates = rawRows.map((raw, index) => {
    const row = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as ResearchEvidenceRow;
    const samples = measurements(row.measurements);
    const liveSamples = samples.filter(sample => !sample.isRevoked).length;
    const revokedSamples = samples.length - liveSamples;
    const total = unsignedOrNull(row.totalFeedback);
    const registration = stringOrNull(row.agentId) ?? stringOrNull(row.id) ?? `record-${index + 1}`;
    const wallet = stringOrNull(row.agentWallet);
    const limitations: string[] = [];
    if (!wallet) limitations.push("No service wallet was present in the returned registration.");
    if (total === null) limitations.push("The source did not provide a parseable indexed feedback count.");
    if (!samples.length) limitations.push("No recent feedback sample was returned for this record.");
    if (revokedSamples > 0) limitations.push(`${revokedSamples} of ${samples.length} sampled feedback entries were marked revoked.`);
    return {
      registration,
      wallet,
      indexedFeedback: total === null ? null : String(total),
      sampledFeedback: samples.length,
      activeSampledFeedback: liveSamples,
      revokedSampledFeedback: revokedSamples,
      evidence: [
        total === null ? "Indexed feedback count unavailable" : `${total} indexed feedback records reported by the selected source`,
        `${liveSamples} active and ${revokedSamples} revoked entries in the bounded recent sample`,
        wallet ? `Service wallet present: ${wallet}` : "Service wallet missing",
      ],
      limitations,
      _rankFeedback: total ?? -1n,
      _rankLiveSamples: liveSamples,
    };
  }).sort((a, b) => {
    if (a._rankFeedback !== b._rankFeedback) return a._rankFeedback > b._rankFeedback ? -1 : 1;
    if (a._rankLiveSamples !== b._rankLiveSamples) return b._rankLiveSamples - a._rankLiveSamples;
    return a.registration.localeCompare(b.registration);
  });

  const supported = candidates.find(candidate => candidate.wallet && candidate.indexedFeedback !== null) ?? null;
  const publicCandidates = candidates.map(({ _rankFeedback, _rankLiveSamples, ...candidate }) => candidate);
  const limitations = [
    "This ranks evidence coverage in one bounded result; it does not calculate a universal trust or quality score.",
    "Feedback values can use incompatible measurement units, so raw values are not averaged.",
    "Reviewer identity and independence are not established by this task.",
    `Only ${task.source.chain} deployment ${task.source.deployment} was queried; other chains were not silently substituted.`,
  ];
  if (!sourceBlock(payload.sourceMetadata)) limitations.push("The source response did not expose a parseable block number.");
  if (!publicCandidates.length) limitations.unshift("The selected source returned no matching Agent0 registrations.");

  return {
    schemaVersion: 1,
    task: { ...task, purpose: RESEARCH_PURPOSE },
    recommendation: supported ? {
      status: "best_supported_record",
      registration: supported.registration,
      wallet: supported.wallet,
      basis: "Highest indexed feedback count among returned records with a service wallet. This is evidence coverage, not a quality guarantee.",
    } : {
      status: "insufficient_evidence",
      registration: null,
      wallet: null,
      basis: "No returned record had both a service wallet and a parseable indexed feedback count.",
    },
    candidates: publicCandidates,
    alternatives: publicCandidates.filter(candidate => candidate.registration !== supported?.registration).map(candidate => ({
      registration: candidate.registration,
      wallet: candidate.wallet,
      whyNotSelected: supported
        ? "The selected result contained less indexed evidence coverage, or lost a deterministic tie-break. This is not a negative quality judgment."
        : "Evidence was insufficient to select any candidate.",
    })),
    limitations,
    provenance: {
      provider: task.source.provider,
      chain: task.source.chain,
      deployment: task.source.deployment,
      blockNumber: sourceBlock(payload.sourceMetadata),
      observedAt: typeof payload.observedAt === "string" ? payload.observedAt : accounting.completedAt,
    },
    accounting,
    payment: payload.paid ?? null,
  };
}
