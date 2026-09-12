/** Pre-payment HTTP retry, adapted from x402-agentic-orchestrator src/services/http-retry.ts.
 * Never attach this to a request that already carries a payment signature. */
const DEFAULT_RETRY_STATUSES = new Set([408, 429, 502, 503, 504]);

export interface FetchWithRetryOptions {
  attempts?: number;
  retryOn?: number[];
  baseDelayMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const attempts = options.attempts ?? 3;
  const retryOn = new Set(options.retryOn ?? [...DEFAULT_RETRY_STATUSES]);
  const baseDelayMs = options.baseDelayMs ?? 800;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchFn = options.fetch ?? fetch;
  const userSignal = options.signal ?? init.signal;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (userSignal?.aborted) throw userSignal.reason instanceof Error ? userSignal.reason : new Error("Aborted");
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = userSignal ? AbortSignal.any([userSignal, timeout]) : timeout;
    try {
      const res = await fetchFn(url, { ...init, signal });
      if (retryOn.has(res.status) && attempt < attempts) {
        await sleep(baseDelayMs * attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (userSignal?.aborted) throw lastError;
      const retryable =
        lastError.name === "TimeoutError" ||
        lastError.name === "AbortError" ||
        /fetch failed|network|ECONNRESET|ETIMEDOUT/i.test(lastError.message);
      if (!retryable || attempt >= attempts) throw lastError;
      await sleep(baseDelayMs * attempt);
    }
  }
  throw lastError ?? new Error(`request failed after ${attempts} attempts`);
}
