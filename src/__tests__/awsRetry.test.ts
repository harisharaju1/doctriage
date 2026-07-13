import { describe, expect, it } from 'vitest';
import { isBedrockRetriableError } from '../utils/awsRetry.js';

// AWS SDK v3 errors carry their type in `.name`, not `.constructor.name` the
// way Anthropic SDK errors do (see isRetriableError's tests in
// retry.test.ts) — setting `.name` directly on a plain Error is the
// simplest way to construct a realistic-enough fake without depending on
// the actual @aws-sdk error classes in a unit test.
function awsError(name: string, message = 'aws error'): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('isBedrockRetriableError', () => {
  it('returns true for ThrottlingException', () => {
    expect(isBedrockRetriableError(awsError('ThrottlingException'))).toBe(true);
  });

  it('returns true for ServiceUnavailableException', () => {
    expect(isBedrockRetriableError(awsError('ServiceUnavailableException'))).toBe(true);
  });

  it('returns true for ModelTimeoutException', () => {
    expect(isBedrockRetriableError(awsError('ModelTimeoutException'))).toBe(true);
  });

  it('returns true for generic network errors', () => {
    expect(isBedrockRetriableError(new Error('socket hang up ECONNRESET'))).toBe(true);
    expect(isBedrockRetriableError(new Error('connect ETIMEDOUT'))).toBe(true);
  });

  it('returns false for ValidationException — retrying identical bad input wastes quota', () => {
    expect(isBedrockRetriableError(awsError('ValidationException', 'invalid input'))).toBe(false);
  });

  it('returns false for AccessDeniedException — retrying wrong credentials never succeeds', () => {
    expect(isBedrockRetriableError(awsError('AccessDeniedException'))).toBe(false);
  });

  it('returns false for non-errors', () => {
    expect(isBedrockRetriableError('a string')).toBe(false);
    expect(isBedrockRetriableError(null)).toBe(false);
  });
});
