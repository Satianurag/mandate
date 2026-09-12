/** Saved agent configuration. It grants no payment authority by itself. */
export const AGENT_TOOL_IDS = ["graph-agent0", "graph-protocol", "web-search", "crypto-news", "crypto-prices", "hedera-analysis"] as const;
export type AgentToolId = typeof AGENT_TOOL_IDS[number];
export interface AgentProfile {
  id: string;
  version: number;
  template: boolean;
  name: string;
  description: string;
  instructions: string;
  goal: string;
  output: string;
  toolIds: AgentToolId[];
  budgetBaseUnits: string;
  perCallBaseUnits: string;
  maxSteps: number;
  maxDurationSeconds: number;
}

function boundedText(value: unknown, name: string, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max) throw new Error(`${name} must contain ${empty ? "0" : "1"}–${max} characters`);
  return value.trim();
}
function amount(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,11}$/.test(value)) throw new Error(`${name} must be a positive integer in USDC base units`);
  return value;
}
export function validateAgentProfile(input: Record<string, unknown>): Omit<AgentProfile, "id" | "version" | "template"> {
  const allowed = new Set(["name", "description", "instructions", "goal", "output", "toolIds", "budgetBaseUnits", "perCallBaseUnits", "maxSteps", "maxDurationSeconds"]);
  for (const field of Object.keys(input)) if (!allowed.has(field)) throw new Error(`Unsupported agent field: ${field}`);
  if (!Array.isArray(input.toolIds) || !input.toolIds.length || input.toolIds.some(id => !AGENT_TOOL_IDS.includes(id as AgentToolId)) || new Set(input.toolIds).size !== input.toolIds.length) throw new Error("Choose distinct tools from the supported catalog");
  const budgetBaseUnits = amount(input.budgetBaseUnits, "Budget"), perCallBaseUnits = amount(input.perCallBaseUnits, "Per-call limit");
  if (BigInt(perCallBaseUnits) > BigInt(budgetBaseUnits)) throw new Error("Per-call limit exceeds total budget");
  const maxSteps = input.maxSteps, maxDurationSeconds = input.maxDurationSeconds;
  if (!Number.isSafeInteger(maxSteps) || Number(maxSteps) < 2 || Number(maxSteps) > 30) throw new Error("Choose 2–30 steps");
  if (!Number.isSafeInteger(maxDurationSeconds) || Number(maxDurationSeconds) < 30 || Number(maxDurationSeconds) > 1800) throw new Error("Choose a runtime of 30–1800 seconds");
  return {
    name: boundedText(input.name, "Name", 80), description: boundedText(input.description, "Description", 400, true),
    instructions: boundedText(input.instructions, "Instructions", 8000), goal: boundedText(input.goal, "Goal", 8000, true),
    output: boundedText(input.output, "Expected output", 2000), toolIds: [...input.toolIds] as AgentToolId[],
    budgetBaseUnits, perCallBaseUnits, maxSteps: Number(maxSteps), maxDurationSeconds: Number(maxDurationSeconds),
  };
}
