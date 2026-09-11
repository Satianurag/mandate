import { assertHederaTestnet } from "./testnet.ts";
/**
 * Scheduled-transaction treasury top-up leg (HIP-423 long-term schedules).
 *
 * Problem: the gateway payer account must never strand mid-demo with an
 * empty balance. Fix: a funded treasury pre-authorizes a time-locked HBAR
 * top-up (treasury -> payer) as a Hedera scheduled transaction with
 * `wait_for_expiry = true`. The network executes it at `expiration_time`
 * without any further action; if the payer is still healthy the operator
 * deletes the schedule via its admin key instead.
 *
 * Fail-safe choices (all deliberate, all tested):
 * - The schedule's execution-fee payer is the FUNDED treasury, never the
 *   depleted payer (a payer that cannot cover the fee would fail execution
 *   with INSUFFICIENT_PAYER_BALANCE).
 * - The live-schedule check fails OPEN toward creating: only a schedule we
 *   can positively identify as live (memo match + unexecuted + unexpired)
 *   blocks creation. A duplicate top-up is harmless (funds stay in-house);
 *   a wrongly-skipped top-up strands the demo.
 * - `setPayerAccountId` takes an `AccountId` object, not a string (the SDK
 *   does not coerce; passing a string throws at freeze). The builder takes
 *   strings and converts, so callers cannot hit this.
 *
 * Docs: https://hips.hedera.com/HIP/hip-423.html
 * Mirror: GET /api/v1/schedules?account.id=... (QuickNode mirror REST ref)
 */
import {
  AccountId,
  Hbar,
  Key,
  ScheduleCreateTransaction,
  Timestamp,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { HEDERA_MIRROR_TESTNET } from "./evidence.ts";

export type TreasuryNetwork = "testnet";

/** HIP-423 caps schedule lifetimes at 2 months from creation. */
export const MAX_SCHEDULE_LIFETIME_DAYS = 60;

/** Memo prefix identifying mandate top-up schedules on-network. */
export const TOPUP_MEMO_PREFIX = "mandate-topup:";

export function treasuryMirrorBase(network: TreasuryNetwork): string {
  assertHederaTestnet(network);
  return HEDERA_MIRROR_TESTNET;
}

export function topUpMemo(payerId: string, hbars: number): string {
  return `${TOPUP_MEMO_PREFIX}${payerId}:${hbars}h`;
}

export interface TopUpPlan {
  /** Funded treasury account, `shard.realm.num`. */
  treasuryId: string;
  /** Gateway payer account to top up, `shard.realm.num`. */
  payerId: string;
  /** Whole HBAR to move treasury -> payer at execution. */
  hbars: number;
  /** Execution time (schedule expiration with wait_for_expiry). */
  executeAt: Date;
}

/**
 * Build (offline) the ScheduleCreate for a time-locked top-up. The caller
 * freezes, signs with the treasury key, and executes; the schedule ID comes
 * back on the receipt. Throws on invalid plans before any network use.
 */
export function buildTopUpSchedule(plan: TopUpPlan, adminKey: Key): ScheduleCreateTransaction {
  if (!Number.isFinite(plan.hbars) || plan.hbars <= 0) {
    throw new Error(`top-up hbars must be positive, got ${plan.hbars}`);
  }
  const nowMs = Date.now();
  const execMs = plan.executeAt.getTime();
  if (!Number.isFinite(execMs) || execMs <= nowMs) {
    throw new Error("top-up executeAt must be in the future");
  }
  if (execMs - nowMs > MAX_SCHEDULE_LIFETIME_DAYS * 86_400_000) {
    throw new Error(
      `top-up executeAt exceeds HIP-423 max lifetime of ${MAX_SCHEDULE_LIFETIME_DAYS} days`,
    );
  }
  const treasury = AccountId.fromString(plan.treasuryId);
  const payer = AccountId.fromString(plan.payerId);
  const inner = new TransferTransaction()
    .addHbarTransfer(treasury, new Hbar(-plan.hbars))
    .addHbarTransfer(payer, new Hbar(plan.hbars));
  return new ScheduleCreateTransaction()
    .setScheduledTransaction(inner)
    .setAdminKey(adminKey)
    .setPayerAccountId(treasury)
    .setScheduleMemo(topUpMemo(plan.payerId, plan.hbars))
    .setExpirationTime(Timestamp.fromDate(plan.executeAt))
    .setWaitForExpiry(true);
}

/** True when the payer balance has fallen below the top-up threshold. */
export function needsTopUp(balanceTinybars: bigint, thresholdTinybars: bigint): boolean {
  return balanceTinybars < thresholdTinybars;
}

export interface PendingTopUp {
  scheduleId: string;
  memo: string;
  expirationTime: string;
}

interface MirrorSchedule {
  schedule_id?: string;
  memo?: string;
  executed_timestamp?: string | null;
  expiration_time?: string | null;
}

/**
 * Find a live top-up schedule in a mirror `/schedules` list payload. Live =
 * memo match + never executed + expiration still in the future. Anything
 * uncertain (missing fields, unparsable time) is NOT live: the caller then
 * creates a fresh schedule (fail-open, funds-safe).
 */
export function findLiveTopUp(schedulesJson: unknown, memo: string, now: Date = new Date()): PendingTopUp | null {
  const schedules = (schedulesJson as { schedules?: MirrorSchedule[] } | null)?.schedules;
  if (!Array.isArray(schedules)) return null;
  for (const s of schedules) {
    if (typeof s !== "object" || s === null) continue;
    if (s.memo !== memo) continue;
    if (typeof s.schedule_id !== "string" || s.schedule_id === "") continue;
    if (s.executed_timestamp !== null && s.executed_timestamp !== undefined) continue;
    if (typeof s.expiration_time !== "string") continue;
    const expMs = Date.parse(s.expiration_time);
    if (!Number.isFinite(expMs) || expMs <= now.getTime()) continue;
    return { scheduleId: s.schedule_id, memo, expirationTime: s.expiration_time };
  }
  return null;
}

export interface TreasuryMirrorOpts {
  network?: TreasuryNetwork;
  fetchImpl?: typeof fetch;
}

/** Read the payer's tinybar balance via the mirror node. */
export async function fetchPayerBalanceTinybars(
  payerId: string,
  opts: TreasuryMirrorOpts = {},
): Promise<bigint> {
  const base = treasuryMirrorBase(opts.network ?? "testnet");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${base}/accounts/${payerId}`);
  if (!res.ok) throw new Error(`mirror accounts ${payerId} -> HTTP ${res.status}`);
  const body = (await res.json()) as { balance?: { balance?: number } };
  const balance = body?.balance?.balance;
  if (typeof balance !== "number" || !Number.isFinite(balance) || balance < 0) {
    throw new Error(`mirror accounts ${payerId} -> unparsable balance`);
  }
  return BigInt(Math.trunc(balance));
}

/**
 * Check the mirror node for a live top-up schedule created by the treasury.
 * Follows `links.next` up to 3 pages; returns null when none is live.
 */
export async function fetchLiveTopUp(
  treasuryId: string,
  memo: string,
  opts: TreasuryMirrorOpts = {},
): Promise<PendingTopUp | null> {
  const base = treasuryMirrorBase(opts.network ?? "testnet");
  const fetchImpl = opts.fetchImpl ?? fetch;
  let url: string | null =
    `${base}/schedules?account.id=${treasuryId}&order=desc&limit=25`;
  for (let page = 0; page < 3 && url !== null; page++) {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`mirror schedules -> HTTP ${res.status}`);
    const body = (await res.json()) as { links?: { next?: string | null } };
    const live = findLiveTopUp(body, memo);
    if (live !== null) return live;
    const next = body?.links?.next;
    url = typeof next === "string" && next !== "" ? next : null;
  }
  return null;
}
