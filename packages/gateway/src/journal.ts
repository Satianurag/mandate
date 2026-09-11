/** Durable broker accounting. All monetary values are integer base-unit strings. */
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === undefined) throw new Error("Undefined is not a journal value");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
export const digest = (v: unknown): string => createHash("sha256").update(canonical(v)).digest("hex");
export function units(value: string, positive = false): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error("Invalid integer base units");
  const n = BigInt(value);
  if (n >= 2n ** 256n || (positive && n === 0n)) throw new Error("Base units out of range");
  return n;
}
export interface BudgetLimits {
  ceilingBaseUnits: string;
  perCallBaseUnits: string;
  windowBaseUnits: string;
  windowMs: number;
}
export interface StoredResponse { status: number; headers: Record<string, string>; body: string }
export interface RequestRow {
  id: string; mandate_id: string; digest: string; network: string; asset: string;
  maximum: string; charged: string | null; state: string; created_at: number;
  finished_at: number | null; payload_hash: string | null; receipt: string | null;
  response: string | null; error: string | null;
}
export interface MandateRow {
  id: string; descriptor: string; state: string; channel_id: string | null;
  deposit: string; payer: string | null; session: string | null; created_at: number;
}
export interface FullySpentClosureProof {
  network: string;
  channelId: string;
  balanceBaseUnits: string;
  claimedBaseUnits: string;
  receiverAggregateClaimedBaseUnits: string;
  receiverAggregateSettledBaseUnits: string;
  withdrawalAmountBaseUnits: string;
  blockNumber?: string;
  observedAt?: string;
}
export interface TimedWithdrawalSnapshot {
  network: string;
  channelId: string;
  balanceBaseUnits: string;
  claimedBaseUnits: string;
  payerBalanceBaseUnits: string;
  receiverAggregateClaimedBaseUnits: string;
  receiverAggregateSettledBaseUnits: string;
  withdrawalAmountBaseUnits: string;
  withdrawalInitiatedAt: number;
  blockNumber?: string;
  observedAt?: string;
}
export interface TimedWithdrawalInitiatedProof {
  transaction: string;
  amountBaseUnits: string;
  readyAt: number;
  before: TimedWithdrawalSnapshot;
  after: TimedWithdrawalSnapshot;
}
export interface TimedWithdrawalFinalizedProof {
  transaction: string;
  returnedBaseUnits: string;
  before: TimedWithdrawalSnapshot;
  after: TimedWithdrawalSnapshot;
}
export interface EventRow {
  seq: number; id: string; mandate_id: string; request_id: string | null;
  kind: string; data: string; previous_hash: string; hash: string; created_at: number;
}
export interface OutboxRow extends EventRow {
  anchor_state: string; attempts: number; receipt: string | null; error: string | null;
}
export class Journal {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS mandates (
        id TEXT PRIMARY KEY, descriptor TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active',
        channel_id TEXT, deposit TEXT NOT NULL DEFAULT 'none', payer TEXT, session TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL REFERENCES mandates(id), digest TEXT NOT NULL,
        network TEXT NOT NULL, asset TEXT NOT NULL, maximum TEXT NOT NULL, charged TEXT,
        state TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER, payload_hash TEXT,
        receipt TEXT, response TEXT, error TEXT);
      CREATE INDEX IF NOT EXISTS request_mandate ON requests(mandate_id, network, asset);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, mandate_id TEXT NOT NULL,
        request_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, previous_hash TEXT NOT NULL,
        hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT PRIMARY KEY REFERENCES events(id), anchor_state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, receipt TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS owners (name TEXT PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outcomes (
        payment_hash TEXT PRIMARY KEY, request_digest TEXT NOT NULL, state TEXT NOT NULL,
        response TEXT, error TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (
        nonce TEXT PRIMARY KEY, action_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', evidence TEXT);
    `);
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  register(id: string, descriptor: unknown): MandateRow {
    return this.transaction(() => {
      const text = canonical(descriptor);
      const prior = this.mandate(id);
      if (prior && prior.descriptor !== text) throw new Error("Mandate scope is immutable; a changed scope requires a new salt and authorization");
      if (!prior) {
        this.db.prepare("INSERT INTO mandates(id,descriptor,created_at) VALUES(?,?,?)").run(id, text, Date.now());
        this.append(id, null, "mandate.configured", descriptor);
      }
      return this.mandate(id)!;
    });
  }
  mandate(id: string): MandateRow | undefined {
    return this.db.prepare("SELECT * FROM mandates WHERE id=?").get(id) as unknown as MandateRow | undefined;
  }
  mandates(): MandateRow[] { return this.db.prepare("SELECT * FROM mandates ORDER BY created_at DESC").all() as unknown as MandateRow[]; }
  assertActive(id: string): void {
    const row = this.mandate(id);
    if (!row || row.state !== "active") throw new Error(`Mandate is ${row?.state ?? "not configured"}; new spending is blocked`);
  }
  refundConfirmed(id:string, proof:{transaction:string;returnedBaseUnits:string;before:{channelId:string};after:{channelId:string}}):void {
    this.transaction(()=>{
      const row=this.mandate(id);
      if(!row || row.channel_id!==proof.before.channelId || row.channel_id!==proof.after.channelId || !/^0x[0-9a-fA-F]{64}$/.test(proof.transaction) || units(proof.returnedBaseUnits)<=0n)throw new Error("Refund proof does not bind to this mandate");
      if(row.state==="refunded") {
        const existing=this.events(id).find(event=>event.kind==="refund.transaction_confirmed");
        if(!existing || JSON.parse(existing.data).transaction!==proof.transaction)throw new Error("Conflicting refund proof");
        return;
      }
      this.db.prepare("UPDATE mandates SET state='refunded' WHERE id=?").run(id);
      this.append(id,null,"refund.transaction_confirmed",proof);
    });
  }
  withdrawalInitiated(id: string, proof: TimedWithdrawalInitiatedProof): void {
    this.transaction(() => {
      const row = this.mandate(id);
      if (!row || row.deposit !== "funded" || !row.channel_id) throw new Error("Only a funded mandate with a pinned channel can start timed withdrawal");
      if (["refunded", "closed"].includes(row.state)) throw new Error("Terminal mandate cannot start timed withdrawal");
      if (row.state === "withdrawal_pending") {
        const existing = this.events(id).find(event => event.kind === "withdrawal.initiated");
        if (!existing || JSON.parse(existing.data).transaction !== proof.transaction) throw new Error("Conflicting timed withdrawal proof");
        return;
      }
      if (!/^0x[0-9a-fA-F]{64}$/.test(proof.transaction) || units(proof.amountBaseUnits, true) <= 0n) throw new Error("Timed withdrawal proof is malformed");
      if (proof.before.channelId.toLowerCase() !== row.channel_id.toLowerCase() || proof.after.channelId.toLowerCase() !== row.channel_id.toLowerCase()) throw new Error("Timed withdrawal proof is for another channel");
      if (proof.before.network !== proof.after.network) throw new Error("Timed withdrawal proof changes network");
      const unresolved = this.requests(id).filter(request => ["reserved", "signed", "uncertain"].includes(request.state));
      if (unresolved.length) throw new Error("Resolve uncertain or reserved payment liabilities before timed withdrawal");
      const totals = this.totals(id, Number.MAX_SAFE_INTEGER);
      if (units(totals.reserved) !== 0n || units(totals.spent) !== units(proof.after.claimedBaseUnits)) throw new Error("Accepted liability is not fully claimed before timed withdrawal");
      if (units(proof.after.receiverAggregateClaimedBaseUnits) !== units(proof.after.receiverAggregateSettledBaseUnits)) throw new Error("Merchant revenue remains unsettled");
      if (units(proof.before.withdrawalAmountBaseUnits) !== 0n || units(proof.after.withdrawalAmountBaseUnits) !== units(proof.amountBaseUnits)) throw new Error("Timed withdrawal pending amount does not match the reviewed amount");
      if (proof.after.withdrawalInitiatedAt <= 0 || proof.readyAt <= proof.after.withdrawalInitiatedAt) throw new Error("Timed withdrawal delay proof is invalid");
      if (proof.before.balanceBaseUnits !== proof.after.balanceBaseUnits || proof.before.claimedBaseUnits !== proof.after.claimedBaseUnits || proof.before.payerBalanceBaseUnits !== proof.after.payerBalanceBaseUnits) throw new Error("Initiation unexpectedly moved or changed channel funds");
      this.db.prepare("UPDATE mandates SET state='withdrawal_pending' WHERE id=?").run(id);
      this.append(id, null, "withdrawal.initiated", proof);
    });
  }
  withdrawalFinalized(id: string, proof: TimedWithdrawalFinalizedProof): void {
    this.transaction(() => {
      const row = this.mandate(id);
      if (!row || row.deposit !== "funded" || !row.channel_id) throw new Error("Only a funded mandate with a pinned channel can finalize timed withdrawal");
      if (row.state === "refunded") {
        const existing = this.events(id).find(event => event.kind === "withdrawal.transaction_confirmed");
        if (!existing || JSON.parse(existing.data).transaction !== proof.transaction) throw new Error("Conflicting timed withdrawal finalization proof");
        return;
      }
      if (row.state !== "withdrawal_pending") throw new Error("No confirmed timed withdrawal is pending");
      if (!/^0x[0-9a-fA-F]{64}$/.test(proof.transaction) || units(proof.returnedBaseUnits, true) <= 0n) throw new Error("Timed withdrawal finalization proof is malformed");
      if (proof.before.channelId.toLowerCase() !== row.channel_id.toLowerCase() || proof.after.channelId.toLowerCase() !== row.channel_id.toLowerCase()) throw new Error("Timed withdrawal finalization is for another channel");
      const returned = units(proof.returnedBaseUnits, true);
      if (units(proof.before.withdrawalAmountBaseUnits) !== returned || units(proof.after.withdrawalAmountBaseUnits) !== 0n) throw new Error("Timed withdrawal finalization does not clear the reviewed pending amount");
      if (units(proof.before.balanceBaseUnits) - units(proof.after.balanceBaseUnits) !== returned || units(proof.after.payerBalanceBaseUnits) - units(proof.before.payerBalanceBaseUnits) !== returned) throw new Error("Timed withdrawal finalization does not prove the expected payer return");
      if (proof.before.claimedBaseUnits !== proof.after.claimedBaseUnits || proof.after.balanceBaseUnits !== proof.after.claimedBaseUnits) throw new Error("Timed withdrawal did not leave exactly the accepted liability in the channel");
      if (proof.after.receiverAggregateClaimedBaseUnits !== proof.after.receiverAggregateSettledBaseUnits) throw new Error("Merchant revenue remains unsettled after timed withdrawal");
      this.db.prepare("UPDATE mandates SET state='refunded' WHERE id=?").run(id);
      this.append(id, null, "withdrawal.transaction_confirmed", proof);
    });
  }
  closeFullySpent(id: string, ceilingBaseUnits: string, proof: FullySpentClosureProof): void {
    this.transaction(() => {
      const row = this.mandate(id);
      if (!row || row.deposit !== "funded" || !row.channel_id) throw new Error("Only a funded mandate with a pinned channel can close as fully spent");
      if (row.state === "refunded") throw new Error("A refunded mandate cannot also close as fully spent");
      if (row.state === "closed") {
        const existing = this.events(id).find(event => event.kind === "mandate.closed");
        const data = existing ? JSON.parse(existing.data) as { reason?: string; spentBaseUnits?: string; proof?: { channelId?: string } } : null;
        if (!data || data.reason !== "fully_spent" || data.spentBaseUnits !== String(units(ceilingBaseUnits, true)) || data.proof?.channelId?.toLowerCase() !== row.channel_id.toLowerCase()) {
          throw new Error("Conflicting mandate closure proof");
        }
        return;
      }
      const descriptor = JSON.parse(row.descriptor) as { scope?: { network?: string; ceilingBaseUnits?: string }; network?: string; ceilingBaseUnits?: string };
      const describedNetwork = descriptor.scope?.network ?? descriptor.network;
      const describedCeiling = descriptor.scope?.ceilingBaseUnits ?? descriptor.ceilingBaseUnits;
      if (describedNetwork && proof.network !== describedNetwork) throw new Error("Closure proof is for another network");
      if (describedCeiling && String(units(describedCeiling, true)) !== String(units(ceilingBaseUnits, true))) throw new Error("Closure ceiling differs from the configured mandate");
      const unresolved = this.requests(id).filter(request => ["reserved", "signed", "uncertain"].includes(request.state));
      if (unresolved.length > 0) throw new Error("Resolve uncertain or reserved payment liabilities before closing the mandate");
      const ceiling = units(ceilingBaseUnits, true);
      const totals = this.totals(id, Number.MAX_SAFE_INTEGER);
      if (units(totals.reserved) !== 0n || units(totals.spent) !== ceiling) throw new Error("Mandate is not fully consumed according to durable accounting");
      if (proof.channelId.toLowerCase() !== row.channel_id.toLowerCase()) throw new Error("Closure proof is for another channel");
      if (units(proof.balanceBaseUnits) !== ceiling || units(proof.claimedBaseUnits) !== ceiling) throw new Error("On-chain channel is not fully consumed");
      if (units(proof.receiverAggregateClaimedBaseUnits) !== units(proof.receiverAggregateSettledBaseUnits)) throw new Error("Merchant revenue remains unsettled");
      if (units(proof.withdrawalAmountBaseUnits) !== 0n) throw new Error("An outstanding withdrawal prevents terminal closure");
      this.db.prepare("UPDATE mandates SET state='closed' WHERE id=?").run(id);
      this.append(id, null, "mandate.closed", {
        reason: "fully_spent",
        spentBaseUnits: String(ceiling),
        refundableBaseUnits: "0",
        proof,
      });
    });
  }
  stop(id: string): void {
    this.transaction(() => {
      const row = this.mandate(id);
      if (!row) throw new Error("Unknown mandate");
      if (["stopped", "refunded", "closed", "withdrawal_pending"].includes(row.state)) return;
      this.db.prepare("UPDATE mandates SET state='stopped' WHERE id=?").run(id);
      this.append(id, null, "mandate.stopped", { paidRequestsAreNotReversed: true });
    });
  }
  bindIdentity(id: string, payer: string, session: string): void {
    this.transaction(() => {
      const row = this.mandate(id);
      if (!row) throw new Error("Unknown mandate");
      if ((row.payer && row.payer.toLowerCase() !== payer.toLowerCase()) ||
          (row.session && row.session.toLowerCase() !== session.toLowerCase())) throw new Error("Mandate signer identity changed");
      this.db.prepare("UPDATE mandates SET payer=?,session=? WHERE id=?").run(payer, session, id);
    });
  }
  bindChannel(id: string, channel: string): void {
    this.transaction(() => {
      const row = this.mandate(id);
      if (!row || (row.channel_id && row.channel_id !== channel)) throw new Error("Merchant changed the pinned channel configuration");
      this.db.prepare("UPDATE mandates SET channel_id=? WHERE id=?").run(channel, id);
    });
  }
  /** No time-based lock stealing: a paused but live signer must never be duplicated. */
  own(name: string): () => void {
    const token = randomUUID();
    this.transaction(() => {
      const owner = this.db.prepare("SELECT pid FROM owners WHERE name=?").get(name) as { pid: number } | undefined;
      if (owner) {
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code !== "ESRCH"; }
        if (alive) throw new Error(`Another broker owns ${name}; parallel signing is forbidden`);
        this.db.prepare("DELETE FROM owners WHERE name=?").run(name);
      }
      this.db.prepare("INSERT INTO owners VALUES(?,?,?)").run(name, process.pid, token);
    });
    return () => { this.db.prepare("DELETE FROM owners WHERE name=? AND token=?").run(name, token); };
  }
  request(id: string): RequestRow | undefined {
    return this.db.prepare("SELECT * FROM requests WHERE id=?").get(id) as unknown as RequestRow | undefined;
  }
  requests(id: string): RequestRow[] {
    return this.db.prepare("SELECT * FROM requests WHERE mandate_id=? ORDER BY created_at DESC").all(id) as unknown as RequestRow[];
  }
  totals(id: string, windowMs: number, now = Date.now()): { spent: string; reserved: string; window: string } {
    let spent = 0n, reserved = 0n, window = 0n;
    for (const r of this.requests(id)) {
      if (r.state === "accepted") {
        const n = units(r.charged!); spent += n;
        if ((r.finished_at ?? r.created_at) >= now - windowMs) window += n;
      } else if (["reserved", "signed", "uncertain"].includes(r.state)) {
        reserved += units(r.maximum);
      }
    }
    return { spent: String(spent), reserved: String(reserved), window: String(window + reserved) };
  }
  reserve(input: { id: string; mandateId: string; digest: string; network: string; asset: string; amount: string; limits: BudgetLimits; now?: number }): RequestRow {
    return this.transaction(() => {
      this.assertActive(input.mandateId);
      const prior = this.request(input.id);
      if (prior) {
        if (prior.digest !== input.digest || prior.mandate_id !== input.mandateId) throw new Error("Idempotency key is already bound to a different request");
        throw new Error(`Request ${input.id} is already ${prior.state}; replay its result or reconcile, never pay again`);
      }
      const n = units(input.amount, true), l = input.limits;
      if (!Number.isSafeInteger(l.windowMs) || l.windowMs <= 0) throw new Error("Invalid budget window");
      if (n > units(l.perCallBaseUnits, true)) throw new Error("Per-call limit exceeded");
      const totals = this.totals(input.mandateId, l.windowMs, input.now);
      if (units(totals.spent) + units(totals.reserved) + n > units(l.ceilingBaseUnits, true)) throw new Error("Lifetime budget exhausted");
      if (units(totals.window) + n > units(l.windowBaseUnits, true)) throw new Error("Rolling budget exhausted");
      this.db.prepare("INSERT INTO requests(id,mandate_id,digest,network,asset,maximum,state,created_at) VALUES(?,?,?,?,?,?,'reserved',?)")
        .run(input.id, input.mandateId, input.digest, input.network, input.asset, input.amount, input.now ?? Date.now());
      this.append(input.mandateId, input.id, "request.reserved", { maximum: input.amount, network: input.network, asset: input.asset, digest: input.digest });
      return this.request(input.id)!;
    });
  }
  depositOnce(id: string): void {
    this.transaction(() => {
      this.assertActive(id);
      if (this.mandate(id)?.deposit !== "none") throw new Error("A deposit was already attempted; top-ups and silent retries are forbidden");
      this.db.prepare("UPDATE mandates SET deposit='pending' WHERE id=?").run(id);
      this.append(id, null, "deposit.authorization_requested", {});
    });
  }
  funded(id: string, proof: unknown): void {
    this.transaction(() => {
      const row = this.mandate(id);
      if (row?.deposit === "funded") return;
      if (row?.deposit !== "pending") throw new Error("No pending deposit to confirm");
      this.db.prepare("UPDATE mandates SET deposit='funded' WHERE id=?").run(id);
      this.append(id, null, "deposit.chain_confirmed", proof);
    });
  }
  signed(id: string, payload: unknown): void {
    this.transaction(() => {
      const r = this.request(id);
      if (!r || !["reserved", "signed"].includes(r.state)) throw new Error("Request cannot produce another signature");
      this.assertActive(r.mandate_id);
      this.db.prepare("UPDATE requests SET state='signed',payload_hash=? WHERE id=?").run(digest(payload), id);
      this.append(r.mandate_id, id, "request.signed", { payload });
    });
  }
  accept(id: string, charged: string, receipt: unknown): void {
    this.transaction(() => {
      const r = this.request(id);
      if (!r) throw new Error("Unknown payment request");
      const amount = units(charged);
      if (amount > units(r.maximum)) throw new Error("Settlement exceeds reserved maximum");
      if (r.state === "accepted") {
        if (r.charged !== charged || r.receipt !== canonical(receipt)) throw new Error("Conflicting settlement for one request");
        return;
      }
      if (!["signed", "uncertain"].includes(r.state)) throw new Error("Unsigned request cannot settle");
      this.db.prepare("UPDATE requests SET state='accepted',charged=?,receipt=?,finished_at=? WHERE id=?")
        .run(charged, canonical(receipt), Date.now(), id);
      this.append(r.mandate_id, id, "payment.accepted", { charged, receipt, onchainRevenueConfirmed: false });
    });
  }
  fail(id: string, error: string): void {
    this.transaction(() => {
      const r = this.request(id);
      if (!r || ["accepted", "failed"].includes(r.state)) return;
      const state = r.state === "reserved" ? "failed" : "uncertain";
      this.db.prepare("UPDATE requests SET state=?,error=?,finished_at=? WHERE id=?").run(state, error, Date.now(), id);
      this.append(r.mandate_id, id, `request.${state}`, { error, reservationRetained: state === "uncertain" });
    });
  }
  saveResponse(id: string, response: StoredResponse): void {
    this.db.prepare("UPDATE requests SET response=? WHERE id=?").run(canonical(response), id);
  }
  event(mandateId: string, requestId: string | null, kind: string, data: unknown): string {
    return this.transaction(() => this.append(mandateId, requestId, kind, data));
  }
  private append(mandateId: string, requestId: string | null, kind: string, data: unknown): string {
    const prev = this.db.prepare("SELECT hash FROM events ORDER BY seq DESC LIMIT 1").get() as { hash: string } | undefined;
    const id = randomUUID(), at = Date.now(), text = canonical(data), previous = prev?.hash ?? "";
    const hash = digest({ id, mandateId, requestId, kind, data, previous, at });
    this.db.prepare("INSERT INTO events(id,mandate_id,request_id,kind,data,previous_hash,hash,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, mandateId, requestId, kind, text, previous, hash, at);
    this.db.prepare("INSERT INTO outbox(event_id) VALUES(?)").run(id);
    return id;
  }
  events(id?: string): OutboxRow[] {
    return this.db.prepare(`SELECT e.*,o.anchor_state,o.attempts,o.receipt,o.error FROM events e JOIN outbox o ON o.event_id=e.id
      ${id ? "WHERE e.mandate_id=?" : ""} ORDER BY e.seq DESC LIMIT 500`).all(...(id ? [id] : [])) as unknown as OutboxRow[];
  }
  pendingEvents(limit = 25): OutboxRow[] {
    return this.db.prepare("SELECT e.*,o.anchor_state,o.attempts,o.receipt,o.error FROM events e JOIN outbox o ON o.event_id=e.id WHERE o.anchor_state != 'confirmed' ORDER BY e.seq LIMIT ?")
      .all(limit) as unknown as OutboxRow[];
  }
  pendingCount(): number {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE anchor_state != 'confirmed'").get()?.n ?? 0);
  }
  verifyEventChain(): boolean {
    let previous = "";
    for (const event of this.db.prepare("SELECT * FROM events ORDER BY seq").all() as unknown as EventRow[]) {
      if (event.previous_hash !== previous || digest({ id: event.id, mandateId: event.mandate_id, requestId: event.request_id,
        kind: event.kind, data: JSON.parse(event.data), previous, at: event.created_at }) !== event.hash) return false;
      previous = event.hash;
    }
    return true;
  }
  anchored(id: string, receipt: unknown): void {
    this.db.prepare("UPDATE outbox SET anchor_state='confirmed',attempts=attempts+1,receipt=?,error=NULL WHERE event_id=?")
      .run(canonical(receipt), id);
  }
  anchorFailed(id: string, error: string): void {
    this.db.prepare("UPDATE outbox SET anchor_state='failed',attempts=attempts+1,error=? WHERE event_id=?").run(error, id);
  }
  merchantReceipt(paymentHash: string, requestDigest: string): StoredResponse | null {
    const row = this.db.prepare("SELECT request_digest,response FROM outcomes WHERE payment_hash=?").get(paymentHash) as {request_digest:string;response:string|null}|undefined;
    if (!row || !row.response) return null;
    if (row.request_digest !== requestDigest) throw new Error("Receipt belongs to another resource");
    return JSON.parse(row.response) as StoredResponse;
  }
  resetUnsignedDeposit(id: string): void {
    this.transaction(() => {
      const row = this.mandate(id);
      if (row?.deposit !== "pending") throw new Error("Only an unresolved deposit can be recovered");
      const signatures = this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE mandate_id=? AND kind IN ('deposit.signature_verified','request.signed')").get(id);
      if (Number(signatures?.n) > 0) throw new Error("A signature exists; unsigned-deposit recovery is forbidden");
      this.db.prepare("UPDATE mandates SET deposit='none' WHERE id=?").run(id);
      this.db.prepare("UPDATE requests SET state='failed',error='No deposit signature was produced',finished_at=? WHERE mandate_id=? AND state='reserved'").run(Date.now(),id);
      this.append(id,null,"deposit.unsigned_attempt_recovered",{newFundingAuthorized:false});
    });
  }
  merchantBegin(paymentHash: string, requestDigest: string): StoredResponse | null {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM outcomes WHERE payment_hash=?").get(paymentHash) as { request_digest: string; state: string; response: string | null } | undefined;
      if (row) {
        if (row.request_digest !== requestDigest) throw new Error("Payment replayed for a different resource");
        if (row.response) return JSON.parse(row.response) as StoredResponse;
        throw new Error(`Payment outcome ${row.state}; reconciliation required before retry`);
      }
      this.db.prepare("INSERT INTO outcomes(payment_hash,request_digest,state,created_at) VALUES(?,?,'preparing',?)")
        .run(paymentHash, requestDigest, Date.now());
      return null;
    });
  }
  merchantState(hash: string, state: "settling" | "uncertain", error?: string): void {
    this.db.prepare("UPDATE outcomes SET state=?,error=? WHERE payment_hash=?").run(state, error ?? null, hash);
  }
  merchantComplete(hash: string, response: StoredResponse): void {
    this.db.prepare("UPDATE outcomes SET state='complete',response=? WHERE payment_hash=?").run(canonical(response), hash);
  }
  challenge(action: unknown, expiresAt: number): string {
    const nonce = randomUUID();
    this.db.prepare("INSERT INTO approvals(nonce,action_hash,expires_at) VALUES(?,?,?)").run(nonce, digest(action), expiresAt);
    return nonce;
  }
  consumeApproval(nonce: string, action: unknown, evidence: unknown, now = Date.now()): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM approvals WHERE nonce=?").get(nonce) as { action_hash: string; state: string; expires_at: number } | undefined;
      if (!row || row.action_hash !== digest(action) || row.state !== "pending" || row.expires_at < now) throw new Error("Approval missing, expired, mismatched or already consumed");
      this.db.prepare("UPDATE approvals SET state='consumed',evidence=? WHERE nonce=?").run(canonical(evidence), nonce);
    });
  }
}
