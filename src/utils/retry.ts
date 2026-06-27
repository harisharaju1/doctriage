export type DelayFn = (ms: number) => Promise<void>;

const defaultDelay: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  shouldRetry?: (err: unknown) => boolean;
  delayFn?: DelayFn;
}

export interface AttemptContext {
  attempt: number; // 0-indexed
  totalAttempts: number;
}

// Runs fn up to maxAttempts times with exponential backoff + jitter.
// delayFn is injectable so tests can run without real timers.
export async function withRetry<T>(
  fn: (ctx: AttemptContext) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const { maxAttempts, baseDelayMs, shouldRetry = () => true, delayFn = defaultDelay } = opts;

  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn({ attempt, totalAttempts: maxAttempts });
    } catch (err) {
      lastErr = err;
      const isLast = attempt === maxAttempts - 1;
      if (isLast || !shouldRetry(err)) throw err;

      const backoffMs = baseDelayMs * 2 ** attempt + Math.random() * 500;
      await delayFn(backoffMs);
    }
  }

  throw lastErr;
}

export function isRetriableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // Anthropic SDK error names
  if (
    err.constructor.name === 'APIConnectionError' ||
    err.constructor.name === 'APIConnectionTimeoutError' ||
    err.constructor.name === 'InternalServerError'
  ) {
    return true;
  }

  // Rate limit — always retriable
  if (err.constructor.name === 'RateLimitError') return true;

  // Generic network errors
  const networkCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND'];
  return networkCodes.some((code) => err.message.includes(code));
}
