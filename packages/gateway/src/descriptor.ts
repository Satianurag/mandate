/**
 * Step-up clear-sign payload — EIP-712 typed data shown field-by-field on the
 * Ethereum app (no blind-signing mode required for structured EIP-712).
 * Full ERC-7730 v2 contract descriptors are a later upgrade.
 */
import type { PaymentProposal } from "./types.ts";

export interface StepUpTypedData {
  domain: {
    name?: string;
    version?: string;
    chainId?: number;
    verifyingContract?: string;
    salt?: string;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** Plain-text fallback / audit log line. */
export function formatStepUpMessage(proposal: PaymentProposal, reason: string): string {
  const payTo = proposal.requirements.payTo;
  const amount = proposal.normalisedAmount;
  const asset = proposal.assetSymbol;
  const origin = proposal.origin;
  return [
    "Mandate — approve this payment?",
    "",
    `Amount: ${amount} ${asset}`,
    `Recipient: ${payTo}`,
    `Service: ${origin}`,
    "",
    `Policy: ${reason}`,
  ].join("\n");
}

/** EIP-712 descriptor — device shows each field on the trusted display. */
export function buildStepUpTypedData(proposal: PaymentProposal, reason: string): StepUpTypedData {
  const recipient = proposal.requirements.payTo;
  const amountTinybar = proposal.requirements.amount;

  return {
    domain: {
      name: "Mandate",
      version: "1",
      chainId: 1,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      MandateStepUp: [
        { name: "amountTinybar", type: "uint256" },
        { name: "asset", type: "string" },
        { name: "recipient", type: "string" },
        { name: "policyReason", type: "string" },
      ],
    },
    primaryType: "MandateStepUp",
    message: {
      amountTinybar,
      asset: proposal.assetSymbol,
      recipient,
      policyReason: reason.slice(0, 120),
    },
  };
}
