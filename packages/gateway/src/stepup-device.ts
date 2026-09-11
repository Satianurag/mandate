/** Only action-bound typed-data signing. No address-confirmation or blind-signing fallback. */
import { getAddress, type Hex } from "viem";
import { DmkEvmSigner } from "./dmksigner.ts";
import type { ApprovalChallenge } from "./stepup.ts";
export async function signStepUpOnDevice(challenge: ApprovalChallenge, expectedOperator: `0x${string}`, timeoutMs: number): Promise<Hex> {
  const device = await DmkEvmSigner.create({ path: process.env.MANDATE_LEDGER_PATH, timeoutMs });
  if (getAddress(device.address) !== getAddress(expectedOperator)) throw new Error("Connected Ledger is not the configured approving principal");
  console.error("Review the action-bound EIP-712 approval on Ledger. Reject any unexpected request.");
  const signature = await device.signTypedData(challenge);
  // The DMK report records actual device behavior. Do not claim ERC-7730 clear signing from a config flag.
  return signature;
}
