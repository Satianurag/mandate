/** Turn DMK / signer-kit error objects into readable strings. */
export function formatLedgerError(err: unknown): string {
  if (!err) return "device action failed";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    if (typeof o.message === "string" && o.message.trim()) return o.message;
    if (typeof o._tag === "string") {
      const code = o.errorCode !== undefined ? ` (${String(o.errorCode)})` : "";
      return `${o._tag}${code}`;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
