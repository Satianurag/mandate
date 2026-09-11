/** Broker-enforced authority. These rules are NOT claimed to be on-device labels. */
import { getAddress } from "viem";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { units, type BudgetLimits } from "./journal.ts";

export interface MandateScope extends BudgetLimits {
  network: Network;
  serviceUrl: string;
  asset: `0x${string}`;
  receiver: `0x${string}`;
  receiverAuthorizer: `0x${string}`;
  withdrawDelay: number;
  expiresAt: string;
}
export function validateScope(scope: MandateScope): MandateScope {
  if (!scope || typeof scope !== "object") throw new Error("An explicit mandate scope is required");
  if (!["eip155:84532", "eip155:296"].includes(scope.network)) throw new Error("Mandate supports explicitly configured testnets only");
  for (const field of ["asset", "receiver", "receiverAuthorizer"] as const) {
    if (getAddress(scope[field]) === "0x0000000000000000000000000000000000000000") throw new Error(`${field} cannot be zero`);
  }
  const service = new URL(scope.serviceUrl);
  if (service.username || service.password || service.hash || service.search) throw new Error("Service URL must not contain credentials, query or fragment");
  if (service.protocol !== "https:" && !(service.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(service.hostname))) {
    throw new Error("Use HTTPS, or HTTP on loopback only");
  }
  const ceiling = units(scope.ceilingBaseUnits, true);
  if (ceiling >= 2n ** 128n) throw new Error("Escrow values must fit the stock uint128 contract bounds");
  if (units(scope.perCallBaseUnits, true) > ceiling || units(scope.windowBaseUnits, true) > ceiling) throw new Error("Per-call and rolling budgets cannot exceed the lifetime ceiling");
  if (!Number.isSafeInteger(scope.windowMs) || scope.windowMs < 1000 || scope.windowMs > 31 * 86400000) throw new Error("Invalid rolling budget window");
  if (!Number.isSafeInteger(scope.withdrawDelay) || scope.withdrawDelay < 60 || scope.withdrawDelay > 31 * 86400) throw new Error("Invalid withdrawal delay");
  if (typeof scope.expiresAt !== "string" || !scope.expiresAt.endsWith("Z") || !Number.isFinite(Date.parse(scope.expiresAt))) throw new Error("Expiry must be a UTC ISO timestamp");
  return Object.freeze({ ...scope, serviceUrl: service.toString(), asset: getAddress(scope.asset), receiver: getAddress(scope.receiver), receiverAuthorizer: getAddress(scope.receiverAuthorizer) });
}
export function assertUnexpired(scope: MandateScope, now = Date.now()): void {
  if (now >= Date.parse(scope.expiresAt)) throw new Error("Mandate permission has expired; withdrawal delay is not permission expiry");
}
export function assertRequestScope(scope: MandateScope, input: string | URL | Request, init?: RequestInit, recovery = false): URL {
  if (!recovery) assertUnexpired(scope);
  const req = input instanceof Request ? new Request(input, init) : new Request(input, init);
  const u = new URL(req.url), allowed = new URL(scope.serviceUrl);
  if (u.username || u.password || u.hash || u.origin !== allowed.origin || u.pathname !== allowed.pathname) throw new Error("Request origin or path is outside the mandate");
  if (req.method !== "GET" || req.body) throw new Error("Only bounded read-only GET requests are authorized");
  const keys = [...u.searchParams.keys()];
  if (keys.some(k => k !== "q") || u.searchParams.getAll("q").length > 1) throw new Error("Only one q parameter is allowed");
  if (u.toString().length > 16000) throw new Error("Request is too large");
  for (const name of ["authorization", "cookie", "payment-signature", "x-payment", "host"]) {
    if (req.headers.has(name)) throw new Error(`Caller-controlled ${name} is forbidden`);
  }
  return u;
}
export function assertPaymentScope(scope: MandateScope, r: PaymentRequirements, now = Date.now()): void {
  assertUnexpired(scope, now);
  if (r.scheme !== "batch-settlement" || r.network !== scope.network) throw new Error("Payment scheme or network is outside the mandate");
  if (getAddress(r.asset) !== scope.asset || getAddress(r.payTo) !== scope.receiver) throw new Error("Payment asset or receiver is outside the mandate");
  if (units(r.amount, true) > units(scope.perCallBaseUnits)) throw new Error("Per-call limit exceeded");
  if (getAddress(String(r.extra?.receiverAuthorizer)) !== scope.receiverAuthorizer || r.extra?.withdrawDelay !== scope.withdrawDelay) throw new Error("Merchant changed the authorized channel configuration");
}
