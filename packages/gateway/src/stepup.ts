/**
 * The consent gate.
 *
 * There is deliberately no stub, mock, or bypass: a faked device approval
 * would be a false record of human consent. Tests inject a fake device
 * function through `deps` (dependency injection at the boundary); every
 * other caller touches real hardware. Live proof: `npm run e2e:stepup`.
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

export interface StepUpDeps {
  signOnDevice?: (
    proposal: PaymentProposal,
    reason: string,
    timeoutMs: number
  ) => Promise<void>;
}

export async function requireDeviceApproval(
  req: StepUpRequest,
  deps: StepUpDeps = {}
): Promise<boolean> {
  const sign =
    deps.signOnDevice ??
    ((await import("./stepup-device.ts")).signStepUpOnDevice);
  try {
    await sign(req.proposal, req.reason, req.timeoutMs);
    return true;
  } catch (e) {
    throw new StepUpDenied(formatLedgerError(e));
  }
}
