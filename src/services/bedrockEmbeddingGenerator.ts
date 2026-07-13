// src/services/bedrockEmbeddingGenerator.ts
//
// The real EmbeddingGenerator implementation — calls Amazon Titan Text
// Embeddings V2 through AWS Bedrock. This is the production path; tests use
// MockEmbeddingGenerator instead (see that file's header for why).
//
// WHY TITAN V2, AND WHY 1024 DIMENSIONS: see docs/week-2-day-3.md's "UPDATE
// — Option A is not available" section for the full story. Short version:
// the original plan assumed Titan v1 (1536 dimensions, no schema change
// needed); v1 doesn't exist in Bedrock's current model catalog at all, so
// this project uses v2 — the only Titan text-embedding model actually
// offered — at 1024 dimensions (AWS's own default of the three configurable
// options: 256/512/1024). This required a real schema migration
// (src/db/migrations/002_titan_v2_dimension.sql), which is also why real
// migration tracking exists in this project as of today.
//
// WHY WRAPPED IN withRetry() + AN ABORT SIGNAL: identical reasoning to
// classifier.ts's callClaude() — a network call to any external LLM/model
// API can fail transiently (rate limits, brief service blips) or hang
// indefinitely without an explicit timeout. Reusing Week 1 Day 5's
// withRetry() utility here (rather than writing a second retry
// implementation) is the concrete proof that abstraction generalizes to any
// external API, not just Anthropic's — it just needs its own `shouldRetry`
// predicate (isBedrockRetriableError, src/utils/awsRetry.ts) because AWS SDK
// errors don't look like Anthropic SDK errors.

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import pino from 'pino';
import { loadEnv } from '../config/env.js';
import { isBedrockRetriableError } from '../utils/awsRetry.js';
import { withRetry } from '../utils/retry.js';
import type { EmbeddingGenerator } from './embeddingGenerator.js';

const env = loadEnv();
const log = pino({ name: 'bedrockEmbeddingGenerator' });

const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1_000;

// Matches migration 002's `vector(1024)` column exactly. Titan V2 supports
// 256/512/1024; 1024 is AWS's own default and the highest-quality of the
// three, worth the modest extra storage at this project's scale.
const EMBEDDING_DIMENSIONS = 1024;

interface TitanEmbedResponseBody {
  embedding: number[];
  inputTextTokenCount: number;
}

export class BedrockEmbeddingGenerator implements EmbeddingGenerator {
  private readonly client: BedrockRuntimeClient;

  constructor() {
    // credentials are read from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY —
    // the AWS SDK's default credential provider chain picks these up from
    // process.env automatically, the same environment variables env.ts
    // already validates at startup. Passed explicitly here (rather than
    // relying on the SDK's implicit env-var lookup) so it's obvious, reading
    // this file, exactly where the credentials come from — no hidden magic
    // env var names to go hunting for elsewhere.
    this.client = new BedrockRuntimeClient({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }

  async generate(text: string): Promise<number[]> {
    const body = JSON.stringify({
      inputText: text,
      dimensions: EMBEDDING_DIMENSIONS,
      // Normalizing to unit length is Titan's default and generally what
      // you want for cosine-distance search (pgvector's `<=>` operator,
      // already in use since Day 1) — normalized vectors make cosine
      // distance and dot-product-based distance equivalent up to scale,
      // which is a detail worth knowing but not something this project
      // needs to act on beyond accepting the sensible default.
      normalize: true,
    });

    const command = new InvokeModelCommand({
      modelId: env.AWS_BEDROCK_EMBEDDING_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(body),
    });

    const result = await withRetry(
      async ({ attempt }) => {
        log.info({ attempt, maxAttempts: MAX_ATTEMPTS }, 'calling Bedrock for embedding');

        // AbortSignal.timeout() here is the AWS SDK v3 equivalent of the
        // same mechanism classifier.ts already uses for the Anthropic SDK
        // — the second argument to client.send() accepts an abortSignal,
        // and the SDK propagates it down to the underlying HTTP request.
        const response = await this.client.send(command, {
          abortSignal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (!response.body) {
          throw new Error('Bedrock returned an empty response body');
        }

        const parsed = JSON.parse(new TextDecoder().decode(response.body)) as TitanEmbedResponseBody;
        return parsed.embedding;
      },
      {
        maxAttempts: MAX_ATTEMPTS,
        baseDelayMs: BASE_DELAY_MS,
        shouldRetry: isBedrockRetriableError,
      },
    );

    return result;
  }
}
