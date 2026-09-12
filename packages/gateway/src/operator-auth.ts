/** Local operator sessions and a distinct, query-scoped agent capability. */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Journal, digest } from "./journal.ts";

const fresh = () => randomBytes(32).toString("base64url");
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
export type Principal = { role: "operator"; csrf: string; sessionHash: string } |
  { role: "agent"; capabilityId: string; mandateId: string; authorityHash: string; expiresAt: number };
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export class OperatorAuth {
  readonly tokenFile: string;
  private readonly masterHash: Buffer;
  private failures = new Map<string, { count: number; until: number }>();
  private readonly journal: Journal;
  constructor(journal: Journal, directory: string) {
    this.journal = journal;
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    this.tokenFile = join(directory, "operator-token");
    if (!existsSync(this.tokenFile)) writeFileSync(this.tokenFile, fresh(), { mode: 0o600, flag: "wx" });
    chmodSync(this.tokenFile, 0o600);
    const token = readFileSync(this.tokenFile, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Operator token file is malformed; refusing unauthenticated startup");
    this.masterHash = Buffer.from(hash(token), "hex");
    journal.db.exec(`CREATE TABLE IF NOT EXISTS operator_sessions(hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operator_workspace_transitions(hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_capabilities(id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL,
      mandate_id TEXT NOT NULL, query_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);`);
  }
  private cookie(res: ServerResponse, value: string): void {
    const current = res.getHeader("set-cookie");
    if (Array.isArray(current)) res.setHeader("set-cookie", [...current, value]);
    else if (typeof current === "string") res.setHeader("set-cookie", [current, value]);
    else res.setHeader("set-cookie", value);
  }
  private createOperatorSession(res: ServerResponse, now = Date.now()): Principal {
    const session = fresh(), csrf = fresh(), sessionHash = hash(session);
    this.journal.db.prepare("DELETE FROM operator_sessions WHERE expires_at<?").run(now);
    this.journal.db.prepare("INSERT INTO operator_sessions VALUES(?,?,?)").run(sessionHash, csrf, now + 8 * 3600000);
    this.cookie(res, `mandate_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
    return { role: "operator", csrf, sessionHash };
  }
  prepareWorkspaceTransition(res: ServerResponse): void {
    const now = Date.now(), transition = fresh();
    this.journal.db.prepare("DELETE FROM operator_workspace_transitions WHERE expires_at<?").run(now);
    this.journal.db.prepare("INSERT INTO operator_workspace_transitions VALUES(?,?)").run(hash(transition), now + 10 * 60000);
    this.cookie(res, `mandate_workspace=${transition}; HttpOnly; SameSite=Strict; Path=/workspace; Max-Age=600`);
  }
  loginFromWorkspaceTransition(req: IncomingMessage, res: ServerResponse): Principal | null {
    const token = /(?:^|;\s*)mandate_workspace=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];
    if (!token) return null;
    const transitionHash = hash(token), now = Date.now();
    const row = this.journal.db.prepare("SELECT expires_at FROM operator_workspace_transitions WHERE hash=? AND expires_at>?").get(transitionHash, now) as
      { expires_at: number } | undefined;
    this.journal.db.prepare("DELETE FROM operator_workspace_transitions WHERE hash=?").run(transitionHash);
    this.cookie(res, "mandate_workspace=; HttpOnly; SameSite=Strict; Path=/workspace; Max-Age=0");
    return row ? this.createOperatorSession(res, now) : null;
  }
  checkOrigin(req: IncomingMessage, origin: string): void {
    if (req.headers.origin !== origin) throw new HttpError(403, "Operator mutations require the exact local Origin");
    if (req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "Cross-site operator request blocked");
  }
  login(req: IncomingMessage, res: ServerResponse, token: string, origin: string): Principal {
    this.checkOrigin(req, origin);
    const ip = req.socket.remoteAddress ?? "unknown", now = Date.now();
    const previous = this.failures.get(ip);
    if (previous && previous.until > now && previous.count >= 10) throw new HttpError(429, "Too many login attempts; retry after the cooldown");
    if (typeof token !== "string" || token.length > 256 || !timingSafeEqual(Buffer.from(hash(token), "hex"), this.masterHash)) {
      this.failures.set(ip, { count: previous && previous.until > now ? previous.count + 1 : 1, until: now + 300000 });
      throw new HttpError(401, "Invalid operator access token");
    }
    this.failures.delete(ip);
    return this.createOperatorSession(res, now);
  }
  authenticate(req: IncomingMessage, origin: string): Principal {
    const authorization = req.headers.authorization;
    if (authorization) {
      if (req.headers.origin) throw new HttpError(403, "Agent bearer capabilities cannot be used from a browser origin");
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)?.[1];
      if (!token) throw new HttpError(401, "Invalid capability format");
      const row = this.journal.db.prepare("SELECT * FROM agent_capabilities WHERE hash=? AND revoked=0 AND expires_at>?").get(hash(token), Date.now()) as
        { id: string; mandate_id: string; query_hash: string; expires_at: number } | undefined;
      if (!row) throw new HttpError(401, "Agent capability is missing, expired or revoked");
      return { role: "agent", capabilityId: row.id, mandateId: row.mandate_id, authorityHash: row.query_hash, expiresAt: row.expires_at };
    }
    const token = /(?:^|;\s*)mandate_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];
    const row = token ? this.journal.db.prepare("SELECT csrf FROM operator_sessions WHERE hash=? AND expires_at>?").get(hash(token), Date.now()) as { csrf: string } | undefined : undefined;
    if (!token || !row) throw new HttpError(401, "Connect this browser using npm run console:open");
    if (!["GET", "HEAD"].includes(req.method ?? "GET")) {
      this.checkOrigin(req, origin);
      if (req.headers["x-mandate-csrf"] !== row.csrf) throw new HttpError(403, "Missing or invalid operator CSRF token");
    }
    return { role: "operator", csrf: row.csrf, sessionHash: hash(token) };
  }
  operator(principal: Principal): void {
    if (principal.role !== "operator") throw new HttpError(403, "Agent capabilities cannot change authority, access operator evidence or control recovery");
  }
  createCapability(mandateId: string, authority: unknown, expiresAt: number): { id: string; token: string } {
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new HttpError(400, "Capability expiry must be in the future");
    const id = fresh().slice(0, 16), token = fresh(), authorityHash = digest(authority);
    // The legacy column name is retained for a non-destructive SQLite migration. Its value is now the canonical authority hash.
    this.journal.db.prepare("INSERT INTO agent_capabilities(id,hash,mandate_id,query_hash,expires_at) VALUES(?,?,?,?,?)")
      .run(id, hash(token), mandateId, authorityHash, expiresAt);
    this.journal.event(mandateId, null, "agent.capability_created", { id, authorityHash, expiresAt });
    return { id, token };
  }
  revokeCapabilities(mandateId: string): void {
    this.journal.db.prepare("UPDATE agent_capabilities SET revoked=1 WHERE mandate_id=?").run(mandateId);
  }
  logout(principal: Principal, res: ServerResponse): void {
    this.operator(principal);
    if (principal.role === "operator") this.journal.db.prepare("DELETE FROM operator_sessions WHERE hash=?").run(principal.sessionHash);
    this.cookie(res, "mandate_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  }
}
