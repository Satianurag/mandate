import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AccountId,
  Client,
  PrivateKey,
  ScheduleCreateTransaction,
} from "@hiero-ledger/sdk";
import {
  TOPUP_MEMO_PREFIX,
  buildTopUpSchedule,
  fetchLiveTopUp,
  fetchPayerBalanceTinybars,
  findLiveTopUp,
  needsTopUp,
  topUpMemo,
  treasuryMirrorBase,
} from "./treasury.ts";

/** Deterministic dummy key: NEVER a real key (unit-test signing only). */
const DUMMY_KEY = PrivateKey.fromStringECDSA("22".repeat(32));

async function withTestClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  // Construction + freeze + sign are fully offline; nothing executes. The
  // client MUST be closed: its gRPC channels keep the event loop alive and
  // the test runner would never exit.
  const client = Client.forTestnet().setOperator(AccountId.fromString("0.0.12345"), DUMMY_KEY);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

describe("treasury top-up schedule", () => {
  it("builds a wait-for-expiry schedule that round-trips through bytes", async () => {
    const executeAt = new Date(Date.now() + 7 * 86_400_000);
    const tx = buildTopUpSchedule(
      { treasuryId: "0.0.11111", payerId: "0.0.54321", hbars: 25, executeAt },
      DUMMY_KEY.publicKey,
    );
    // NOTE: the SDK's getters throw once frozen, so fields are asserted on
    // the open transaction; the frozen bytes are asserted by round-trip.
    assert.equal(tx.getScheduleMemo, topUpMemo("0.0.54321", 25));
    assert.equal(tx.waitForExpiry, true);
    assert.equal(
      tx.expirationTime?.seconds?.toString(),
      Math.floor(executeAt.getTime() / 1000).toString(),
    );
    const bytes = await withTestClient(async (client) => {
      const frozen = await tx.freezeWith(client);
      await frozen.sign(DUMMY_KEY);
      return frozen.toBytes();
    });
    const back = ScheduleCreateTransaction.fromBytes(bytes) as ScheduleCreateTransaction;
    assert.deepEqual(Buffer.from(back.toBytes()), Buffer.from(bytes));
  });

  it("encodes payer, memo, and expiry on the wire (bytes differ)", async () => {
    const executeAt = new Date(Date.now() + 7 * 86_400_000);
    const admin = DUMMY_KEY.publicKey;
    const bytesFor = (treasuryId: string, hbars: number, exec: Date) =>
      withTestClient(async (client) =>
        (
          await buildTopUpSchedule(
            { treasuryId, payerId: "0.0.54321", hbars, executeAt: exec },
            admin,
          ).freezeWith(client)
        ).toBytes(),
      );
    const base = Buffer.from(await bytesFor("0.0.11111", 25, executeAt));
    assert.notDeepEqual(Buffer.from(await bytesFor("0.0.22222", 25, executeAt)), base);
    assert.notDeepEqual(Buffer.from(await bytesFor("0.0.11111", 26, executeAt)), base);
    assert.notDeepEqual(
      Buffer.from(await bytesFor("0.0.11111", 25, new Date(executeAt.getTime() + 1000))),
      base,
    );
  });

  it("rejects invalid plans before any network use", () => {
    const admin = DUMMY_KEY.publicKey;
    const future = new Date(Date.now() + 86_400_000);
    assert.throws(
      () => buildTopUpSchedule({ treasuryId: "0.0.1", payerId: "0.0.2", hbars: 0, executeAt: future }, admin),
      /positive/,
    );
    assert.throws(
      () => buildTopUpSchedule({ treasuryId: "0.0.1", payerId: "0.0.2", hbars: 5, executeAt: new Date(Date.now() - 1000) }, admin),
      /future/,
    );
    assert.throws(
      () => buildTopUpSchedule({ treasuryId: "0.0.1", payerId: "0.0.2", hbars: 5, executeAt: new Date(Date.now() + 61 * 86_400_000) }, admin),
      /max lifetime/,
    );
    assert.throws(
      () => buildTopUpSchedule({ treasuryId: "nope", payerId: "0.0.2", hbars: 5, executeAt: future }, admin),
    );
  });

  it("memo carries the mandate prefix, payer, and amount", () => {
    assert.equal(topUpMemo("0.0.54321", 25), `${TOPUP_MEMO_PREFIX}0.0.54321:25h`);
  });

  it("needsTopUp trips strictly below the threshold", () => {
    assert.equal(needsTopUp(9n, 10n), true);
    assert.equal(needsTopUp(10n, 10n), false);
    assert.equal(needsTopUp(11n, 10n), false);
  });

  it("findLiveTopUp only matches live schedules (fail-open otherwise)", () => {
    const memo = topUpMemo("0.0.54321", 25);
    const live = {
      schedule_id: "0.0.77777",
      memo,
      executed_timestamp: null,
      expiration_time: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const payload = {
      schedules: [
        { ...live, schedule_id: "0.0.1", memo: "other" },
        { ...live, schedule_id: "0.0.2", executed_timestamp: "2026-01-01T00:00:00.000000000Z" },
        { ...live, schedule_id: "0.0.3", expiration_time: new Date(Date.now() - 1000).toISOString() },
        { ...live, schedule_id: "0.0.4", expiration_time: null },
        live,
      ],
    };
    assert.deepEqual(findLiveTopUp(payload, memo), {
      scheduleId: "0.0.77777",
      memo,
      expirationTime: live.expiration_time,
    });
    assert.equal(findLiveTopUp({ schedules: payload.schedules.slice(0, 4) }, memo), null);
    assert.equal(findLiveTopUp({ schedules: [] }, memo), null);
    assert.equal(findLiveTopUp({}, memo), null);
  });

  it("fetchPayerBalanceTinybars parses the mirror account balance", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ balance: { balance: 12_345_678 } }), { status: 200 })) as typeof fetch;
    assert.equal(await fetchPayerBalanceTinybars("0.0.54321", { fetchImpl }), 12_345_678n);
  });

  it("fetchLiveTopUp follows mirror pages until a live schedule", async () => {
    const memo = topUpMemo("0.0.54321", 25);
    const live = {
      schedule_id: "0.0.77777",
      memo,
      executed_timestamp: null,
      expiration_time: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const calls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      calls.push(String(url));
      const body =
        calls.length === 1
          ? { schedules: [], links: { next: "https://mirror.test/api/v1/schedules?page=2" } }
          : { schedules: [live], links: { next: null } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    assert.deepEqual(await fetchLiveTopUp("0.0.11111", memo, { fetchImpl }), {
      scheduleId: "0.0.77777",
      memo,
      expirationTime: live.expiration_time,
    });
    assert.match(String(calls[0]), /account\.id=0\.0\.11111/);
    assert.equal(calls.length, 2);
  });

  it("treasuryMirrorBase rejects mainnet", () => {
    assert.match(treasuryMirrorBase("testnet"), /testnet/);
    assert.throws(() => treasuryMirrorBase("mainnet" as never), /Testnet-only/);
  });
});
