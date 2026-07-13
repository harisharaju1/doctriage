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

import type { EmbeddingGenerator } from './embeddingGenerator.js';
import { generateMockEmbedding } from './embedding.js';

export class MockEmbeddingGenerator implements EmbeddingGenerator {
  async generate(text: string): Promise<number[]> {
    return generateMockEmbedding(text);
  }
}
