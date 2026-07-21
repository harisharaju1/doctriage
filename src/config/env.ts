import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  // POSTGRES_URL is required as of Week 2 Day 1: src/config/db.ts opens a
  // real connection pool at startup, and src/db/migrate.ts runs a schema
  // migration against it before the server starts listening. Validating it
  // here means a missing/malformed value crashes the process immediately,
  // with a clear message — the same "fail fast at boot" reasoning already
  // applied to ANTHROPIC_API_KEY, instead of surfacing as a confusing error
  // on the first request that happens to touch the database.
  POSTGRES_URL: z.url(),
  // MONGO_URL / REDIS_URL stay optional — no code connects to either yet.
  // Each flips to required the day its own connection code is added.
  MONGO_URL: z.url().optional(),
  REDIS_URL: z.url().optional(),

  // AWS Bedrock credentials — required as of Week 2 Day 3, same fail-fast
  // reasoning as POSTGRES_URL/ANTHROPIC_API_KEY: BedrockEmbeddingGenerator
  // (src/services/bedrockEmbeddingGenerator.ts) is genuinely load-bearing in
  // production from today, so a missing credential should crash startup
  // loudly, not surface as a confusing AWS SDK error on the first /embed call.
  //
  // These are IAM USER access keys, not an IAM ROLE — this app runs on a
  // plain self-managed VPS with no AWS identity of its own (unlike an EC2
  // instance, which could assume a role and need no static keys at all). See
  // docs/week-2-day-3.md's "IAM users and access keys" section for the full
  // reasoning and the least-privilege scoping this key should have in AWS.
  AWS_ACCESS_KEY_ID: z.string().min(1, 'AWS_ACCESS_KEY_ID is required'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1, 'AWS_SECRET_ACCESS_KEY is required'),
  AWS_REGION: z.string().min(1, 'AWS_REGION is required'),
  // Kept out of hardcoded application code so the model can be swapped (or
  // pinned to a specific version) via config alone. Defaults to the current
  // Titan Text Embeddings model — see docs/week-2-day-3.md's "UPDATE" note
  // for why this is v2, not the v1 the original plan assumed (v1 no longer
  // appears in Bedrock's model catalog at all).
  AWS_BEDROCK_EMBEDDING_MODEL_ID: z.string().min(1).default('amazon.titan-embed-text-v2:0'),
  // Week 2 Day 5: the LLM-as-judge model, called through the same Bedrock
  // credentials/region above rather than the direct Anthropic SDK
  // (@anthropic-ai/sdk) that classifier.ts uses. Two deliberate reasons to
  // route the judge through Bedrock instead of just adding a second
  // Anthropic API call: (1) it reuses AWS credentials/plumbing already
  // required and validated above instead of introducing a second unrelated
  // provider surface for one feature, and (2) it's a second concrete example
  // of the "build vs buy vs prompt" tradeoff this project keeps coming back
  // to — here, "which platform do I call the same underlying model through."
  // Defaults to a Bedrock CROSS-REGION INFERENCE PROFILE ID, not the bare
  // foundation-model ID (`anthropic.claude-sonnet-...`) — discovered the
  // hard way: Bedrock rejected the bare model ID with "Invocation of model
  // ID ... with on-demand throughput isn't supported. Retry your request
  // with the ID or ARN of an inference profile that contains this model."
  // Several current Claude models on Bedrock simply aren't invokable
  // on-demand by their plain model ID at all — the inference profile
  // (`<geo-prefix>.<model-id>`) is a distinct Bedrock resource with its own
  // ARN, and the IAM policy's Resource array needs an `inference-profile/...`
  // entry alongside the `foundation-model/...` one for bedrock:InvokeModel
  // to succeed on it. The geo prefix isn't always the calling region's own
  // geography, either — confirmed via `aws bedrock list-inference-profiles`
  // that this specific model is only offered as a `global.`-prefixed
  // profile (worldwide routing), not an `apac.` one, even though every
  // other Bedrock call in this project uses ap-south-1 — worth not assuming
  // the prefix and just listing what Bedrock actually offers per model.
  // Kept out of hardcoded application code the same way
  // AWS_BEDROCK_EMBEDDING_MODEL_ID is, so it can be swapped or pinned
  // without a code change.
  AWS_BEDROCK_JUDGE_MODEL_ID: z.string().min(1).default('global.anthropic.claude-sonnet-4-5-20250929-v1:0'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${result.error.message}`);
  }

  return result.data;
}
