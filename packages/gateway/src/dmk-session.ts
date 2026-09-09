/**
 * DMK session helper — Node HID transport for local gateway step-up.
 */
import { firstValueFrom, timeout, take, filter, tap } from "rxjs";
import {
  DeviceManagementKitBuilder,
  DeviceActionStatus,
  nodeHidTransportFactory,
  type DeviceActionState,
} from "./ledger-cjs.ts";
import { formatLedgerError } from "./ledger-errors.ts";

type Dmk = ReturnType<DeviceManagementKitBuilder["build"]>;

let dmkSingleton: Dmk | null = null;

export function getDmk(): Dmk {
  if (!dmkSingleton) {
    dmkSingleton = new DeviceManagementKitBuilder()
      .addTransport(nodeHidTransportFactory)
      .build();
  }
  return dmkSingleton;
}

/** Release HID so wallet-cli can talk to the device again. */
export function resetDmk(): void {
  if (dmkSingleton) {
    dmkSingleton.close();
    dmkSingleton = null;
  }
}

export async function withDeviceSession<T>(
  fn: (sessionId: string) => Promise<T>,
  discoverTimeoutMs = 60_000
): Promise<T> {
  const dmk = getDmk();
  const device = await firstValueFrom(
    dmk.startDiscovering({}).pipe(timeout({ first: discoverTimeoutMs }), take(1))
  );
  const sessionId = await dmk.connect({
    device,
    sessionRefresherOptions: { isRefresherDisabled: true },
  });
  try {
    return await fn(sessionId);
  } finally {
    await dmk.disconnect({ sessionId }).catch(() => {});
  }
}

export async function awaitDeviceAction<TOutput>(
  observable: { pipe: (...ops: unknown[]) => unknown },
  timeoutMs: number
): Promise<TOutput> {
  const state = await firstValueFrom(
    (observable as import("rxjs").Observable<DeviceActionState<TOutput>>).pipe(
      tap((s) => {
        if (s.status === DeviceActionStatus.Pending) {
          const hint =
            (s as { intermediateValue?: { requiredUserInteraction?: string } }).intermediateValue
              ?.requiredUserInteraction ?? "confirm on device";
          console.error(`>>> Ledger waiting: ${hint}`);
        }
      }),
      filter(
        (s) =>
          s.status === DeviceActionStatus.Completed ||
          s.status === DeviceActionStatus.Error ||
          s.status === DeviceActionStatus.Stopped
      ),
      timeout({ first: timeoutMs }),
      take(1)
    )
  );

  if (state.status === DeviceActionStatus.Error) {
    throw new Error(formatLedgerError(state.error));
  }
  if (state.status === DeviceActionStatus.Stopped) {
    throw new Error("device action stopped by user");
  }
  if (state.status !== DeviceActionStatus.Completed || state.output === undefined) {
    throw new Error("device action did not complete");
  }
  return state.output;
}
