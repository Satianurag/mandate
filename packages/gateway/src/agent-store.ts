/** Agent profiles and run checkpoints share the operator's transactional SQLite DB. */
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { AGENT_TEMPLATES, validateAgentProfile, type AgentProfile } from "./agent-profiles.ts";
import { digest } from "./journal.ts";

export type AgentRunState = "queued" | "running" | "stopping" | "completed" | "partial" | "failed" | "stopped" | "interrupted";
export interface AgentRun {
  id: string; agent: AgentProfile; goal: string; authorityId: string; intentHash: string;
  state: AgentRunState; createdAt: number; updatedAt: number; deadline: number;
  result: string | null; error: string | null;
}
export interface AgentEvent { sequence: number; runId: string; kind: string; data: unknown; createdAt: number }
interface RunRow { id: string; snapshot: string; goal: string; authority_id: string; intent_hash: string; state: AgentRunState; created_at: number; updated_at: number; deadline: number; result: string | null; error: string | null }
const decode = (r: RunRow): AgentRun => ({ id: r.id, agent: JSON.parse(r.snapshot), goal: r.goal, authorityId: r.authority_id, intentHash: r.intent_hash, state: r.state, createdAt: r.created_at, updatedAt: r.updated_at, deadline: r.deadline, result: r.result, error: r.error });
export const TERMINAL_AGENT_STATES = new Set<AgentRunState>(["completed", "partial", "failed", "stopped", "interrupted"]);

export class AgentStore {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS agent_profiles(id TEXT PRIMARY KEY, version INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_runs(id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, goal TEXT NOT NULL, authority_id TEXT NOT NULL, intent_hash TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deadline INTEGER NOT NULL, result TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS agent_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES agent_runs(id), kind TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_events_run ON agent_events(run_id,sequence);`);
  }
  profiles(): AgentProfile[] {
    const saved = this.db.prepare("SELECT body FROM agent_profiles ORDER BY rowid").all() as Array<{ body: string }>;
    return [...structuredClone(AGENT_TEMPLATES), ...saved.map(r => JSON.parse(r.body) as AgentProfile)];
  }
  profile(id: string): AgentProfile {
    const found = this.profiles().find(p => p.id === id);
    if (!found) throw new Error("Agent not found");
    return found;
  }
  save(input: Record<string, unknown>, id?: string, expectedVersion?: number): AgentProfile {
    const fields = validateAgentProfile(input);
    const existing = id ? this.profile(id) : undefined;
    if (existing?.template) throw new Error("Built-in templates cannot be overwritten; save a custom agent");
    if (existing && expectedVersion !== existing.version) throw new Error("Agent changed; reload before saving");
    const profile: AgentProfile = { ...fields, id: existing?.id ?? randomUUID(), template: false, version: (existing?.version ?? 0) + 1 };
    if (existing) {
      const changed = this.db.prepare("UPDATE agent_profiles SET body=?,version=? WHERE id=? AND version=?").run(JSON.stringify(profile), profile.version, profile.id, existing.version);
      if (changed.changes !== 1) throw new Error("Agent changed; reload before saving");
    } else this.db.prepare("INSERT INTO agent_profiles(id,version,body) VALUES(?,?,?)").run(profile.id, profile.version, JSON.stringify(profile));
    return profile;
  }
  createRun(input: { id: string; agentId: string; goal: string; authorityId: string }, now = Date.now()): AgentRun {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.id)) throw new Error("A durable request ID is required");
    if (typeof input.goal !== "string" || !input.goal.trim() || input.goal.length > 8000) throw new Error("A goal of 1–8000 characters is required");
    if (!input.authorityId) throw new Error("Reviewed spending authority is required");
    const existing = this.run(input.id);
    // Retry intent binds to the ORIGINAL snapshot even if the saved profile was edited.
    if (existing) {
      if (existing.agent.id !== input.agentId || existing.goal !== input.goal.trim() || existing.authorityId !== input.authorityId) throw new Error("Request ID already belongs to a different run intent");
      return existing;
    }
    const agent = this.profile(input.agentId), goal = input.goal.trim();
    const hash = digest({ agent, goal, authorityId: input.authorityId });
    this.db.prepare("INSERT INTO agent_runs(id,snapshot,goal,authority_id,intent_hash,state,created_at,updated_at,deadline) VALUES(?,?,?,?,?,'queued',?,?,?)")
      .run(input.id, JSON.stringify(agent), goal, input.authorityId, hash, now, now, now + agent.maxDurationSeconds * 1000);
    return this.run(input.id)!;
  }
  run(id: string): AgentRun | null {
    const row = this.db.prepare("SELECT * FROM agent_runs WHERE id=?").get(id) as unknown as RunRow | undefined;
    return row ? decode(row) : null;
  }
  runs(): AgentRun[] { return (this.db.prepare("SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT 100").all() as unknown as RunRow[]).map(decode); }
  event(runId: string, kind: string, data: unknown): void {
    if (!this.run(runId)) throw new Error("Run not found");
    this.db.prepare("INSERT INTO agent_events(run_id,kind,data,created_at) VALUES(?,?,?,?)").run(runId, kind, JSON.stringify(data), Date.now());
  }
  events(runId: string): AgentEvent[] {
    return (this.db.prepare("SELECT * FROM agent_events WHERE run_id=? ORDER BY sequence").all(runId) as Array<{ sequence: number; run_id: string; kind: string; data: string; created_at: number }>).map(r => ({ sequence: r.sequence, runId: r.run_id, kind: r.kind, data: JSON.parse(r.data), createdAt: r.created_at }));
  }
  claim(id: string): boolean {
    return this.db.prepare("UPDATE agent_runs SET state='running',updated_at=? WHERE id=? AND state='queued'").run(Date.now(), id).changes === 1;
  }
  stop(id: string): void {
    const run = this.run(id);
    if (!run) throw new Error("Run not found");
    if (TERMINAL_AGENT_STATES.has(run.state)) return;
    this.db.prepare("UPDATE agent_runs SET state=?,updated_at=? WHERE id=?").run(run.state === "queued" ? "stopped" : "stopping", Date.now(), id);
    this.event(id, "stop_requested", { preventsNewActions: true, reversesPayments: false });
  }
  finish(id: string, state: "completed" | "partial" | "failed" | "stopped", result: string | null, error: string | null = null): void {
    const run = this.run(id);
    if (!run || TERMINAL_AGENT_STATES.has(run.state)) throw new Error("Cannot replace a terminal run");
    this.db.prepare("UPDATE agent_runs SET state=?,result=?,error=?,updated_at=? WHERE id=?").run(run.state === "stopping" ? "stopped" : state, result, error, Date.now(), id);
  }
  interruptActive(): number {
    // Never replay a possibly paid action automatically after process death.
    return Number(this.db.prepare("UPDATE agent_runs SET state='interrupted',error='Broker restarted. Review payment receipts before continuing.',updated_at=? WHERE state IN ('queued','running','stopping')").run(Date.now()).changes);
  }
}
