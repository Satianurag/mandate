/** Test-only ephemeral cryptographic signer: every approval still passes real verification. */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { StepUpDeps } from "../src/stepup.ts";
import { Journal } from "../src/journal.ts";
export function testApproval(journal: Journal): StepUpDeps {
  const account = privateKeyToAccount(generatePrivateKey());
  return { operator: account.address, journal, signOnDevice: challenge => account.signTypedData(challenge) };
}
