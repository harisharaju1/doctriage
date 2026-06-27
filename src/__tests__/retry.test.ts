import { describe, expect, it, vi } from 'vitest';
import { isRetriableError, withRetry } from '../utils/retry.js';

// Instant delay — tests never sleep
const noDelay = async () => {};

describe('withRetry', () => {
  it('returns immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 100, delayFn: noDelay });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries and returns success on the third attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce('ok');

    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 100, delayFn: noDelay });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 100, delayFn: noDelay }),
    ).rejects.toThrow('always fails');

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('calls delayFn with increasing backoff between attempts', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('ok');

    const delays: number[] = [];
    const trackingDelay = async (ms: number) => { delays.push(ms); };

    await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1000, delayFn: trackingDelay });

    expect(delays).toHaveLength(2);
    // Second delay should be larger than first (exponential backoff)
    expect(delays[1]).toBeGreaterThan(delays[0]!);
  });

  it('does not retry when shouldRetry returns false', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('non-retriable'));

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 100,
        delayFn: noDelay,
        shouldRetry: () => false,
      }),
    ).rejects.toThrow('non-retriable');

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('isRetriableError', () => {
  it('returns true for rate limit errors', () => {
    // Class declaration sets constructor.name automatically — no global mutation
    class RateLimitError extends Error {}
    expect(isRetriableError(new RateLimitError('rate limited'))).toBe(true);
  });

  it('returns true for network errors', () => {
    expect(isRetriableError(new Error('socket hang up ECONNRESET'))).toBe(true);
    expect(isRetriableError(new Error('connect ETIMEDOUT'))).toBe(true);
  });

  it('returns false for non-errors', () => {
    expect(isRetriableError('a string')).toBe(false);
    expect(isRetriableError(null)).toBe(false);
  });

  it('returns false for regular errors with no network codes', () => {
    expect(isRetriableError(new Error('something unrelated'))).toBe(false);
  });
});
