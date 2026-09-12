/**
 * DMK session helper — Node HID transport for local gateway step-up.
 */
import { firstValueFrom, timeout, take, filter, tap } from "rxjs";
import {
  DeviceManagementKitBuilder,
  DeviceActionStatus,
  OpenAppDeviceAction,
  nodeHidTransportFactory,
  type DeviceActionState,
} from "./ledger-cjs.ts";
import { formatLedgerError } from "./ledger-errors.ts";

type Dmk = ReturnType<InstanceType<typeof DeviceManagementKitBuilder>["build"]>;

let dmkSingleton: Dmk | null = null;

export function getDmk(): Dmk {
  if (!dmkSingleton) {
    dmkSingleton = new DeviceManagementKitBuilder()
      .addTransport(nodeHidTransportFactory)
      .build();
  }
  return dmkSingleton;
}

/** Release HID so a later session can claim the device. Do not call `dmk.close()`: it can hang the Node event loop. */
export function resetDmk(): void {
  const dmk = dmkSingleton;
  dmkSingleton = null;
  if (!dmk) return;
  try { void dmk.stopDiscovering().catch(() => {}); } catch { /* HID teardown is best-effort. */ }
}

/** Prompt the device to open Ethereum. No-op if it is already open. */
export async function ensureEthereumApp(sessionId: string, timeoutMs: number): Promise<void> {
  const dmk = getDmk();
  const { observable } = dmk.executeDeviceAction({
    sessionId,
    deviceAction: new OpenAppDeviceAction({ input: { appName: "Ethereum" } }),
  });
  try {
    await awaitDeviceAction(observable, timeoutMs);
  } catch (error) {
    throw new Error(`Unlock the Ledger and open Ethereum. ${formatLedgerError(error)}`);
  }
}

export async function withDeviceSession<T>(
  fn: (sessionId: string) => Promise<T>,
  discoverTimeoutMs = 60_000,
  options: { openEthereum?: boolean } = {},
): Promise<T> {
  const dmk = getDmk();
  const device = await firstValueFrom(
    dmk.startDiscovering({}).pipe(timeout({ first: discoverTimeoutMs }), take(1))
  );
  const sessionId = await dmk.connect({
    device,
    sessionRefresherOptions: { isRefresherDisabled: true },
  });
  try { await dmk.stopDiscovering(); } catch { /* Discovery already completed. */ }
  try {
    const session = await firstValueFrom(
      dmk.getDeviceSessionState({ sessionId }).pipe(timeout({ first: 5_000 }), take(1))
    );
    const status = String(session.deviceStatus ?? "");
    if (/LOCKED/i.test(status)) throw new Error("Unlock the Ledger, then open Ethereum");
    if (options.openEthereum) await ensureEthereumApp(sessionId, discoverTimeoutMs);
    return await fn(sessionId);
  } finally {
    await Promise.race([
      dmk.disconnect({ sessionId }).catch(() => undefined),
      new Promise<void>(resolve => setTimeout(resolve, 2_000)),
    ]);
  }
}

export interface DeviceActionTrace {
  status: string;
  step?: string;
  interaction?: string;
}

export async function awaitDeviceAction<TOutput>(
  observable: { pipe: (...ops: unknown[]) => unknown },
  timeoutMs: number,
  trace?: DeviceActionTrace[]
): Promise<TOutput> {
  const stream = observable as import("rxjs").Observable<DeviceActionState<TOutput>>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sub: { unsubscribe(): void } | undefined;
  const state = await new Promise<DeviceActionState<TOutput>>((resolve, reject) => {
    timer = setTimeout(() => {
      sub?.unsubscribe();
      reject(new Error("Timeout has occurred"));
    }, timeoutMs);
    sub = stream.pipe(
        tap((s) => {
          const iv = (
            s as {
              intermediateValue?: { requiredUserInteraction?: string; step?: string };
            }
          ).intermediateValue;
          if (trace) {
            trace.push({
              status: String(s.status),
              step: iv?.step,
              interaction: iv?.requiredUserInteraction,
            });
          }
          if (s.status === DeviceActionStatus.Pending) {
            const hint = iv?.requiredUserInteraction ?? "confirm on device";
            const step = iv?.step ? ` ${iv.step}` : "";
            console.error(`>>> Ledger waiting:${step} ${hint}`);
          }
        }),
        filter(
          (s) =>
            s.status === DeviceActionStatus.Completed ||
            s.status === DeviceActionStatus.Error ||
            s.status === DeviceActionStatus.Stopped
        ),
        take(1)
      )
      .subscribe({
        next: (s) => resolve(s),
        error: (e) => reject(e instanceof Error ? e : new Error(formatLedgerError(e))),
      });
  }).finally(() => {
    if (timer) clearTimeout(timer);
    sub?.unsubscribe();
  });

  if (state.status === DeviceActionStatus.Error) {
    throw new Error(formatLedgerError(state.error));
  }
  if (state.status === DeviceActionStatus.Stopped) {
    throw new Error("device action stopped by user");
  }
  if (state.status !== DeviceActionStatus.Completed) {
    throw new Error("device action did not complete");
  }
  // Some successful DMK actions intentionally return void/undefined (for
  // example OpenAppDeviceAction). Completion status, not output presence, is
  // the success signal.
  return state.output as TOutput;
}
