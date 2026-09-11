import { test } from "node:test";
import assert from "node:assert/strict";
import { of } from "rxjs";
import { DeviceActionStatus } from "./ledger-cjs.ts";
import { awaitDeviceAction } from "./dmk-session.ts";

test("awaitDeviceAction accepts a completed DMK action with void output", async () => {
  const result = await awaitDeviceAction<void>(
    of({ status: DeviceActionStatus.Completed, output: undefined }) as any,
    1_000
  );
  assert.equal(result, undefined);
});

test("awaitDeviceAction returns a completed DMK action payload", async () => {
  const payload = { address: "0x1234" };
  const result = await awaitDeviceAction<typeof payload>(
    of({ status: DeviceActionStatus.Completed, output: payload }) as any,
    1_000
  );
  assert.deepEqual(result, payload);
});
