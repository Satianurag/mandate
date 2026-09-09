/**
 * The consent gate.
 *
 * When policy returns `step_up`, the payment stops here until a human confirms
 * it on the Ledger secure screen. The confirmation is Clear Signed: the device
 * renders recipient and amount in plain language from an ERC-7730 descriptor
 * rather than showing raw calldata, so what the human approves is what is
 * actually signed.
 *
 * Docs: https://developers.ledger.com/docs/clear-signing/overview
 *       https://eips.ethereum.org/EIPS/eip-7730
 *
 * Failure policy: if the device is absent, locked, or times out, this REFUSES.
 * A step-up that cannot be satisfied is a deny, never a fallback to allow.
 */

import type { PaymentProposal } from "./types.ts";

export class StepUpDenied extends Error {
  constructor(reason: string) {
    super(`Device approval not obtained: ${reason}`);
    this.name = "StepUpDenied";
  }
}

export interface StepUpRequest {
  proposal: PaymentProposal;
  /** Why policy escalated. Shown to the human alongside the device prompt. */
  reason: string;
  timeoutMs: number;
}

/**
 * TODO(day-3): implement against @ledgerhq/device-management-kit.
 *
 * Shape:
 *   - discover and connect a device (USB/WebHID for the demo host)
 *   - observe session state; refuse on `locked` or `disconnected`
 *   - send the signing DeviceAction with the ERC-7730 descriptor attached
 *   - resolve only on an explicit user confirmation
 *
 * Record a clean take of this path on Friday. Live device sessions are the
 * single most fragile part of the demo, and a recorded fallback costs nothing.
 */
export async function requireDeviceApproval(req: StepUpRequest): Promise<boolean> {
  void req;
  throw new StepUpDenied("DMK integration not yet implemented -- see Day 3 in docs/plan.md");
}
