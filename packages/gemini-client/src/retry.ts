/**
 * Exponential backoff with jitter. Retries 408/429/5xx and network-level
 * failures; auth errors and 400s (bad schema, bad request) fail fast. An
 * aborted call is never retried -- the caller's timeout already decided.
 */

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Test hook. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function statusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown; code?: unknown } | null;
  const s = e?.status ?? e?.code;
  return typeof s === 'number' ? s : undefined;
}

export function isRetryableError(err: unknown): boolean {
  if ((err as Error)?.name === 'AbortError') return false;
  const status = statusOf(err);
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  return err instanceof Error && /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(err.message);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { maxRetries = 3, initialDelayMs = 500, maxDelayMs = 8_000, signal, sleep = defaultSleep } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (signal?.aborted || attempt >= maxRetries || !isRetryableError(err)) throw err;
      const backoff = Math.min(maxDelayMs, initialDelayMs * 2 ** attempt);
      await sleep(backoff * (0.5 + Math.random() * 0.5));
    }
  }
}
