// src/utils/awsRetry.ts
//
// A second `shouldRetry` predicate for withRetry() (src/utils/retry.ts),
// specific to AWS SDK v3 errors — Week 1 Day 5's isRetriableError() only
// knows how to recognize Anthropic SDK error class names
// (RateLimitError, APIConnectionError, etc.), which look nothing like what
// the AWS SDK throws. withRetry() was already built generic — its
// `shouldRetry` parameter is exactly the seam meant for this — so this adds
// a second predicate rather than trying to make one function understand two
// unrelated SDKs' error shapes. See docs/week-2-day-3.md's "Retry/timeout
// for a second external SDK" section for the full reasoning.

export function isBedrockRetriableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // AWS SDK v3 errors carry their specific error type in `.name` (not
  // `.constructor.name` the way the Anthropic SDK's errors do — different
  // SDKs, different conventions). These three are the ones genuinely worth
  // retrying:
  //   - ThrottlingException: Bedrock's per-account/per-model rate limit was
  //     hit — the request itself was fine, just sent too fast.
  //   - ServiceUnavailableException: a transient failure on AWS's side.
  //   - ModelTimeoutException: the model itself took too long to respond —
  //     distinct from OUR OWN timeout (AbortSignal in
  //     bedrockEmbeddingGenerator.ts), this one comes from AWS.
  // Deliberately NOT retrying things like ValidationException or
  // AccessDeniedException — those mean the request or credentials are wrong,
  // and retrying identical bad input just wastes quota while hiding the real
  // problem, exactly the same reasoning Week 1 Day 5 already applied to a
  // 400 from Anthropic.
  const retriableAwsErrorNames = ['ThrottlingException', 'ServiceUnavailableException', 'ModelTimeoutException'];
  if (retriableAwsErrorNames.includes(err.name)) return true;

  // Generic network errors — the same codes Week 1 Day 5's isRetriableError
  // already checks, reused here rather than duplicated, since a dropped
  // connection means the same thing regardless of which SDK was using it.
  const networkCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND'];
  return networkCodes.some((code) => err.message.includes(code));
}
