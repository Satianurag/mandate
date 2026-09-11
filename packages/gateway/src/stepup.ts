import { assertTestnetNetwork, assertTestnetChain } from "./testnet.ts";
/** One-time EIP-712 consent. Address display is never accepted as payment consent. */
import { getAddress, verifyTypedData, type Hex } from "viem";
import { join } from "node:path";
import type { PaymentProposal } from "./types.ts";
import { Journal, digest, units } from "./journal.ts";
import { formatLedgerError } from "./ledger-errors.ts";
export class StepUpDenied extends Error {
  constructor(reason: string) { super(`Device approval not obtained: ${reason}`); this.name = "StepUpDenied"; }
}
export interface StepUpRequest { proposal: PaymentProposal; reason: string; timeoutMs: number }
export function buildApprovalChallenge(operator: `0x${string}`, action: Record<string, unknown>, nonce: string, issuedAt: number, expiresAt: number, chainId: number) {
  assertTestnetChain(chainId);
  return {
    domain: { name: "Mandate Broker Approval", version: "2", chainId, verifyingContract: operator },
    primaryType: "PaymentApproval" as const,
    types: { PaymentApproval: [
      { name: "requestHash", type: "bytes32" }, { name: "resource", type: "string" },
      { name: "network", type: "string" }, { name: "asset", type: "string" },
      { name: "receiver", type: "string" }, { name: "amount", type: "uint256" },
      { name: "nonce", type: "string" }, { name: "issuedAt", type: "uint256" },
      { name: "expiresAt", type: "uint256" },
    ] },
    message: { requestHash: `0x${digest(action)}` as Hex, resource: String(action.resource),
      network: String(action.network), asset: String(action.asset), receiver: String(action.receiver),
      amount: String(action.amount), nonce, issuedAt, expiresAt },
  };
}
export type ApprovalChallenge = ReturnType<typeof buildApprovalChallenge>;
export interface StepUpDeps {
  operator?: `0x${string}`;
  journal?: Journal;
  signOnDevice?: (challenge: ApprovalChallenge, expectedOperator: `0x${string}`, timeoutMs: number) => Promise<Hex>;
}
export async function requireDeviceApproval(req: StepUpRequest, deps: StepUpDeps = {}): Promise<boolean> {
  let ownJournal: Journal | undefined;
  try {
    const configured = deps.operator ?? process.env.MANDATE_OPERATOR_ADDRESS;
    if (!configured) throw new Error("Configure the expected MANDATE_OPERATOR_ADDRESS independently of the device");
    const operator = getAddress(configured);
    const r = req.proposal.requirements;
    assertTestnetNetwork(r.network);
    units(r.amount, true);
    const resource = req.proposal.requestUrl ?? req.proposal.origin;
    const u = new URL(resource);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new Error("Approval resource is invalid");
    const action = { resource: u.toString(), requestId: req.proposal.requestId ?? null,
      network: r.network, asset: r.asset, receiver: r.payTo, amount: r.amount,
      requirements: r, reason: req.reason };
    const now = Date.now(), expiresAt = now + Math.min(Math.max(req.timeoutMs, 1000), 120000);
    const journal = deps.journal ?? (ownJournal = new Journal(process.env.MANDATE_APPROVAL_JOURNAL ?? join(process.cwd(), "state/approvals.sqlite")));
    const nonce = journal.challenge(action, expiresAt);
    const chainId = r.network.startsWith("eip155:") ? Number(r.network.split(":")[1]) : 296;
    const challenge = buildApprovalChallenge(operator, action, nonce, now, expiresAt, chainId);
    const sign = deps.signOnDevice ?? (await import("./stepup-device.ts")).signStepUpOnDevice;
    const signature = await sign(challenge, operator, req.timeoutMs);
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("Missing canonical 65-byte signature");
    if (!(await verifyTypedData({ ...challenge, address: operator, signature }))) throw new Error("Approval signature does not match the configured operator and action");
    journal.consumeApproval(nonce, action, { challenge, signature, operator });
    journal.event("approvals", req.proposal.requestId ?? null, "approval.consumed", { nonce, action, operator, signature, expiresAt });
    return true;
  } catch (e) { throw new StepUpDenied(formatLedgerError(e)); }
  finally { ownJournal?.close(); }
}
