/** Shared one-off agent used by hermetic tests. Not a product template. */
import type { AgentStore } from "./agent-store.ts";
import type { AgentToolId } from "./agent-profiles.ts";
import { AGENT_TOOL_IDS } from "./agent-profiles.ts";

export const TASK_AGENT_FIELDS = {
  name: "Task agent",
  description: "One-off investigation for a single goal.",
  instructions: "Use only the selected tools. Compare observations. Finish with cited evidence and label gaps.",
  goal: "",
  output: "A sourced report with findings, spending and limitations.",
  toolIds: [...AGENT_TOOL_IDS] as AgentToolId[],
  budgetBaseUnits: "100000",
  perCallBaseUnits: "20000",
  maxSteps: 20,
  maxDurationSeconds: 900,
};

export function seedTaskAgent(store: AgentStore, overrides: Partial<typeof TASK_AGENT_FIELDS> = {}) {
  return store.save({ ...TASK_AGENT_FIELDS, ...overrides, toolIds: overrides.toolIds ?? TASK_AGENT_FIELDS.toolIds });
}
