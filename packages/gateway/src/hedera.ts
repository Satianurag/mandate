/**
 * x402 `exact` scheme settlement on Hedera.
 *
 * The flow is client-driven and deliberately asymmetric: we build the transfer
 * and sign it, but we are NOT the fee payer. The facilitator named in
 * `extra.feePayer` completes and submits it. That means the transaction we
 * sign is inert without the facilitator's signature -- a partially-signed blob
 * is not a bearer instrument, which is what makes it safe to hand over.
 *
 * Spec: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md
 *
 * Verification rules the facilitator enforces, and which we must not violate:
 *   - bare TransferTransaction only; wrapping in ScheduleCreateTransaction is
 *     rejected (so the human-approval escrow path applies to treasury top-ups,
 *     never to the payment itself)
 *   - transactionId.accountId MUST equal the configured feePayer
 *   - net HBAR and net asset transfers MUST each sum to zero
 *   - the fee payer may receive value but must never be a net sender
 *   - the amount credited to payTo MUST equal requirements.amount exactly
 *   - no additional positive transfers to any other party
 */

import type {
  PaymentPayload,
  PaymentRequirements,
  SettlementResponse,
} from "./types.ts";
import type { FacilitatorConfig } from "./facilitators.ts";

/** A facilitator refusal. Never retried — see post(). */
export class FacilitatorError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(message: string, status: number, detail: string) {
    super(message);
    this.name = "FacilitatorError";
    this.status = status;
    this.detail = detail;
  }
}

export const TINYBARS_PER_HBAR = 100_000_000n;

/** "0.0.0" is the sentinel for native HBAR in the Hedera exact scheme. */
export const HBAR_SENTINEL = "0.0.0";

/**
 * Normalise a smallest-unit amount to a human unit for policy comparison.
 *
 * HBAR is quoted in tinybars (1e8 per HBAR); HTS tokens use their own
 * configured decimals. Getting this wrong by one decimal place is the most
 * common failure in this integration, and it fails in the dangerous direction:
 * a 10x under-read slips past the per-call ceiling.
 */
export function normaliseAmount(
  requirements: PaymentRequirements,
  htsDecimals?: number
): { amount: number; symbol: string } {
  const raw = BigInt(requirements.amount);

  if (requirements.asset === HBAR_SENTINEL) {
    return { amount: Number(raw) / Number(TINYBARS_PER_HBAR), symbol: "HBAR" };
  }

  if (htsDecimals === undefined) {
    throw new Error(
      `Cannot normalise HTS amount for asset ${requirements.asset}: token decimals unknown. ` +
        `Fetch them from the mirror node before evaluating policy -- do not assume 6.`
    );
  }
  return { amount: Number(raw) / 10 ** htsDecimals, symbol: requirements.asset };
}

/** Ask the facilitator which networks and schemes it actually supports. */
export async function supported(cfg: FacilitatorConfig): Promise<unknown> {
  const res = await fetch(`${cfg.baseUrl}/supported`);
  return res.json();
}

/**
 * POST /verify.
 *
 * Body shape confirmed by probing the live facilitator on 2026-09-08:
 *   { x402Version, paymentRequirements, paymentPayload }
 *
 * Requirements are passed EXPLICITLY rather than read off the payload: the
 * live PaymentPayload carries scheme/network/payload only, with no embedded
 * copy of the requirements (see types.ts).
 */
export async function verify(
  cfg: FacilitatorConfig,
  requirements: PaymentRequirements,
  payload: PaymentPayload
): Promise<{ isValid: boolean; invalidReason?: string }> {
  return post<{ isValid: boolean; invalidReason?: string }>(
    cfg, "verify", requirements, payload
  );
}

/** POST /settle. Same body shape as /verify. */
export async function settle(
  cfg: FacilitatorConfig,
  requirements: PaymentRequirements,
  payload: PaymentPayload
): Promise<SettlementResponse> {
  return post<SettlementResponse>(cfg, "settle", requirements, payload);
}

async function post<T>(
  cfg: FacilitatorConfig,
  path: "verify" | "settle",
  requirements: PaymentRequirements,
  payload: PaymentPayload
): Promise<T> {
  const res = await fetch(`${cfg.baseUrl}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      x402Version: payload.x402Version,
      paymentRequirements: requirements,
      paymentPayload: payload,
    }),
  });

  // An undecodable transaction returns HTTP 500, not a 4xx (verified
  // 2026-09-08). Treat every non-2xx as terminal: retrying a settle whose
  // outcome is unknown risks paying twice for one request.
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new FacilitatorError(
      `${cfg.name} /${path} returned ${res.status}`,
      res.status,
      detail.slice(0, 400)
    );
  }
  return (await res.json()) as T;
}

/** The header a client sends on the retry, per the x402 spec. */
export function encodePaymentHeader(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/**
 * Build and partially sign the transfer.
 *
 * TODO(day-2): implement against @hiero-ledger/sdk.
 *
 *   const tx = new TransferTransaction()
 *     .addHbarTransfer(from, Hbar.fromTinybars(-amount))
 *     .addHbarTransfer(requirements.payTo, Hbar.fromTinybars(amount))
 *     .setTransactionId(TransactionId.generate(requirements.extra.feePayer))
 *     .setNodeAccountIds([...])
 *     .freeze();
 *
 * Note the transaction ID is generated against the FEE PAYER, not against us.
 * That is counter-intuitive and is the first thing to check when the
 * facilitator returns an invalid-transaction reason.
 *
 * The signing key arrives as a Buffer from keyring.withSecret() and must be
 * consumed inside that callback so it can be zeroed on the way out.
 */
export async function buildAndSign(
  _requirements: PaymentRequirements,
  _signingKey: Buffer
): Promise<string> {
  throw new Error("buildAndSign: not yet implemented -- see Day 2 in docs/plan.md");
}
