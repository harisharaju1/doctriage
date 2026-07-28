// src/services/mockEmbeddingGenerator.ts
//
// Wraps Day 1's deterministic hashing-trick embedding logic
// (generateMockEmbedding, still in src/services/embedding.ts, unchanged)
// behind the EmbeddingGenerator interface. This is what every test in this
// project uses — documents.routes.test.ts, the repository integration
// tests, etc. — so `pnpm test` never needs real AWS credentials to pass.
//
// The underlying work is still 100% synchronous; wrapping it in an `async`
// function is purely to satisfy the EmbeddingGenerator interface's
// `Promise<number[]>` return type, so callers can treat every
// EmbeddingGenerator implementation identically (`await generator.generate(...)`)
// regardless of whether the real implementation is actually asynchronous.

import type { TokenUsage } from './costTracking.js';
import type { EmbeddingGenerator } from './embeddingGenerator.js';
import { generateMockEmbedding } from './embedding.js';

export class MockEmbeddingGenerator implements EmbeddingGenerator {
  // logger is accepted (and ignored) purely to satisfy the
  // EmbeddingGenerator interface — this implementation has nothing to log.
  //
  // Week 3 Day 3: usage is a deterministic, rough estimate
  // (~4 chars/token, the commonly-cited rule of thumb) — good enough to
  // exercise the cost-recording PLUMBING in tests, not a claim about real
  // token accuracy, which was never mock's job. See docs/week-3-day-3.md.
  async generate(text: string): Promise<{ embedding: number[]; usage: TokenUsage }> {
    return {
      embedding: generateMockEmbedding(text),
      usage: { inputTokens: Math.ceil(text.length / 4), outputTokens: 0 },
    };
  }
}
