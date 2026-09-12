/** Adapted from Satianurag/x402-agentic-orchestrator @ b1d5dc4, src/agent/vendor-errors.ts. */
export type VendorErrorKind =
  | "vendor_down"
  | "not_found"
  | "payment_rejected"
  | "verify_failed"
  | "budget"
  | "unknown";

export interface ClassifiedVendorError {
  kind: VendorErrorKind;
  httpStatus: number | null;
  userMessage: string;
  /** Safe to retry before giving up (502/503/timeout — not after successful payment). */
  retryable: boolean;
}

function statusFromMessage(message: string): number | null {
  const got = message.match(/\bgot (\d{3})\b/i);
  if (got) {
    const code = Number(got[1]);
    if (Number.isFinite(code)) return code;
  }
  const m = message.match(/failed \((\d{3})\)/i) ?? message.match(/\b(\d{3})\b/);
  if (!m) return null;
  const code = Number(m[1]);
  return Number.isFinite(code) ? code : null;
}

function hostFromMessage(message: string): string | null {
  const m = message.match(/https?:\/\/([^/\s"'<>]+)/i);
  return m?.[1] ?? null;
}

/** Strip HTML error pages (Cloudflare 5xx) before classification or display. */
export function stripHtmlFromError(message: string): string {
  if (!/<html[\s>]/i.test(message) && !/<!DOCTYPE/i.test(message)) {
    return message.length > 500 ? `${message.slice(0, 500)}…` : message;
  }
  const status = statusFromMessage(message);
  const host = hostFromMessage(message) ?? "The service";
  return `${host} returned HTTP ${status ?? "5xx"} (vendor outage — Cloudflare bad gateway).`;
}

function normalizeErrorMessage(message: string): string {
  return stripHtmlFromError(message);
}

/** Classify tool HTTP/MCP failures for UI + retry policy. */
export function classifyVendorError(raw: unknown): ClassifiedVendorError {
  const rawMessage = raw instanceof Error ? raw.message : String(raw ?? "Unknown error");
  const message = normalizeErrorMessage(rawMessage);
  const lower = message.toLowerCase();
  const httpStatus = statusFromMessage(rawMessage) ?? statusFromMessage(message);
  const host = hostFromMessage(rawMessage) ?? hostFromMessage(message);

  if (/insufficient|exceeds budget|budget/i.test(lower)) {
    return {
      kind: "budget",
      httpStatus,
      userMessage: message,
      retryable: false,
    };
  }

  if (/x402_verify_failed|payment signature could not be verified|invalid_exact_evm_payload_signature/i.test(lower)) {
    return {
      kind: "verify_failed",
      httpStatus: httpStatus ?? 400,
      userMessage:
        "Payment verification failed. Review the existing payment before another attempt.",
      retryable: false,
    };
  }

  if (httpStatus === 402 || /payment rejected \(402\)/i.test(message)) {
    return {
      kind: "payment_rejected",
      httpStatus: 402,
      userMessage: "Payment was rejected — check your USDC balance and try again.",
      retryable: false,
    };
  }

  if (httpStatus === 404 || /\bnot found\b/i.test(lower)) {
    return {
      kind: "not_found",
      httpStatus: 404,
      userMessage: host
        ? `Endpoint not found on ${host}. The tool URL may be outdated in the Bazaar index.`
        : "Tool endpoint not found (404). Try a different tool or re-check price.",
      retryable: false,
    };
  }

  if (
    httpStatus === 502 ||
    httpStatus === 503 ||
    httpStatus === 504 ||
    /bad gateway|service unavailable|gateway timeout/i.test(lower)
  ) {
    return {
      kind: "vendor_down",
      httpStatus,
      userMessage: host
        ? `${host} is temporarily unavailable (HTTP ${httpStatus ?? "5xx"}). This is a vendor outage — try again in a few minutes or pick another tool.`
        : `Vendor service is temporarily unavailable (HTTP ${httpStatus ?? "5xx"}). Try again shortly.`,
      retryable: true,
    };
  }

  if (/timeout|timed out|abort/i.test(lower)) {
    return {
      kind: "vendor_down",
      httpStatus,
      userMessage: host
        ? `${host} did not respond in time. The service may be overloaded.`
        : "The service did not respond in time.",
      retryable: true,
    };
  }

  return {
    kind: "unknown",
    httpStatus,
    userMessage: message.length > 280 ? `${message.slice(0, 280)}…` : message,
    retryable: false,
  };
}

/** User-facing message for probe failures (planning, $0). */
export function classifyProbeFailure(raw: unknown): ClassifiedVendorError {
  const base = classifyVendorError(raw);
  if (base.kind === "vendor_down") {
    return {
      ...base,
      userMessage: base.userMessage.replace("Try again shortly.", "Start run is blocked until this clears."),
    };
  }
  if (base.kind === "not_found") {
    return {
      ...base,
      userMessage: `${base.userMessage} Start run is blocked.`,
      retryable: false,
    };
  }
  if (base.httpStatus != null && base.httpStatus !== 402) {
    return {
      kind: base.kind,
      httpStatus: base.httpStatus,
      userMessage: `Preflight check failed (HTTP ${base.httpStatus}). Expected 402 Payment Required. ${base.userMessage}`,
      retryable: false,
    };
  }
  return base;
}

export function formatUserFacingError(raw: unknown): string {
  return classifyVendorError(raw).userMessage;
}
