/**
 * The consent gate — stub path has no DMK imports (keeps unit tests offline).
 */
import type { PaymentProposal } from "./types.ts";
import { formatLedgerError } from "./ledger-errors.ts";

export class StepUpDenied extends Error {
  constructor(reason: string) {
    super(`Device approval not obtained: ${reason}`);
    this.name = "StepUpDenied";
  }
}

export interface StepUpRequest {
  proposal: PaymentProposal;
  reason: string;
  timeoutMs: number;
}

export async function requireDeviceApproval(
  req: StepUpRequest,
): Promise<boolean> {
  const stub = process.env.MANDATE_STEPUP_STUB?.toLowerCase();
  if (stub === "approve") return true;
  if (stub === "deny") throw new StepUpDenied("stub deny");

  try {
    const { signStepUpOnDevice } = await import("./stepup-device.ts");
    await signStepUpOnDevice(req.proposal, req.reason, req.timeoutMs);
    return true;
  } catch (e) {
    throw new StepUpDenied(formatLedgerError(e));
  }
}
