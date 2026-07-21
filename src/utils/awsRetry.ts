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

  // Week 2 Day 5: a narrow, message-matched exception to the "don't retry
  // AccessDeniedException" rule below — discovered live while wiring up the
  // Bedrock-based LLM-as-judge. A newly-activated AWS Marketplace-listed
  // Bedrock model (which, as of today, is how every current Claude model on
  // Bedrock is distributed) can intermittently reject an otherwise-valid,
  // correctly-IAM-permitted InvokeModel call with an AccessDeniedException
  // whose message says the account's "AWS Marketplace subscription for this
  // model cannot be completed at this time" — observed in this project
  // succeeding on roughly 3 of every 4 calls, with the failures scattered
  // across several minutes, while the subscription was still settling on
  // AWS's side. Matching on the SPECIFIC message (not blindly retrying every
  // AccessDeniedException) matters: a real permission error — wrong IAM
  // policy, wrong resource ARN — should still fail fast rather than burn
  // through retries hiding a genuine misconfiguration.
  if (err.name === 'AccessDeniedException' && err.message.includes('AWS Marketplace subscription')) return true;

  // Generic network errors — the same codes Week 1 Day 5's isRetriableError
  // already checks, reused here rather than duplicated, since a dropped
  // connection means the same thing regardless of which SDK was using it.
  const networkCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND'];
  return networkCodes.some((code) => err.message.includes(code));
}
