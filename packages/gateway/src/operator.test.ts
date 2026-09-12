import { test } from "node:test";
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOperatorApp } from "./operator.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "mandate-operator-"));
  const app = await createOperatorApp({ root, dataDir: directory, port: 0 });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const token = await readFile(join(directory, "operator-token"), "utf8");
  const login = await fetch(`${origin}/api/session`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const csrf = (await login.json() as { csrf: string }).csrf;
  const request = (path: string, body?: unknown, overrides: Record<string, string> = {}) => fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, origin, "x-mandate-csrf": csrf, "content-type": "application/json", ...overrides },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { app, origin, request };
}

test("operator state requires authentication and rejects cross-origin, bad CSRF and Host rebinding", async t => {
  const { origin, request } = await setup(t);
  assert.equal((await fetch(`${origin}/api/state`)).status, 401);
  assert.equal((await request("/api/state")).status, 200);
  const fields = { name: "CSRF probe", description: "x", instructions: "x", goal: "", output: "x", toolIds: ["graph-protocol"], budgetBaseUnits: "100000", perCallBaseUnits: "20000", maxSteps: 5, maxDurationSeconds: 60 };
  assert.equal((await request("/api/agents", fields, { "x-mandate-csrf": "incorrect" })).status, 403);
  assert.equal((await request("/api/agents", fields, { origin: "https://attacker.invalid" })).status, 403);
  const rebound = await new Promise<number>(resolve => {
    const req = httpRequest(`${origin}/api/state`, { headers: { host: "attacker.invalid" } }, res => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.end();
  });
  assert.equal(rebound, 403);
});

test("custom agents persist through the authenticated API without silently granting execution authority", async t => {
  const { request, origin } = await setup(t);
  assert.equal((await fetch(`${origin}/api/agents`)).status, 401);
  const before = await (await request("/api/agents")).json() as { agents: unknown[]; ready: boolean };
  assert.equal(before.agents.length, 0);
  assert.equal(before.ready, false);
  const fields = {
    name: "My investigator",
    description: "One-off",
    instructions: "Use live sources.",
    goal: "",
    output: "A sourced report.",
    toolIds: ["graph-protocol"],
    budgetBaseUnits: "100000",
    perCallBaseUnits: "20000",
    maxSteps: 12,
    maxDurationSeconds: 300,
  };
  const savedResponse = await request("/api/agents", fields);
  assert.equal(savedResponse.status, 201);
  const saved = (await savedResponse.json() as { agent: { id: string } }).agent;
  const after = await (await request("/api/agents")).json() as { agents: Array<{ id: string }> };
  assert.equal(after.agents.length, 1);
  assert.equal(after.agents[0]!.id, saved.id);
  assert.equal((await request("/api/agent-runs", { requestId: "agent-test-request", agentId: saved.id, goal: "Investigate" })).status, 409);
});

test("retired operator mutations return 410", async t => {
  const { request, app } = await setup(t);
  for (const path of ["/api/config", "/api/tasks", "/api/delegate", "/api/settle", "/api/refund"]) {
    assert.equal((await request(path, {})).status, 410);
  }
  assert.equal(app.journal.mandates().length, 0);
});

test("the canonical workspace HTML has no legacy frontend assets", async t => {
  const { origin } = await setup(t);
  const html = await (await fetch(`${origin}/`)).text();
  assert.doesNotMatch(html, /loginPanel|legacy-|compat-only|style\.css|mandate-sculpture/);
  for (const path of ["/index.html", "/style.css", "/mandate-sculpture.png", "/onboard/done.html"]) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404);
  }
});
