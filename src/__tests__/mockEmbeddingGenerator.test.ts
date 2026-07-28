import { describe, expect, it } from 'vitest';
import { MockEmbeddingGenerator } from '../services/mockEmbeddingGenerator.js';
import { generateMockEmbedding } from '../services/embedding.js';

// Mostly a sanity check — the underlying hashing-trick logic
// (generateMockEmbedding) already has coverage via the Postgres integration
// tests that insert its output into a real table. This just confirms the
// EmbeddingGenerator wrapper delegates correctly and satisfies the
// interface's async contract.
describe('MockEmbeddingGenerator', () => {
  it('delegates to generateMockEmbedding and returns the same vector', async () => {
    const generator = new MockEmbeddingGenerator();
    const text = 'a claim about a vehicle collision';

    const result = await generator.generate(text);

    expect(result.embedding).toEqual(generateMockEmbedding(text));
  });

  // Week 3 Day 3: usage is a deterministic estimate, not real token counts
  // (mock has no network call to report real usage from) — just confirming
  // the shape is present and sane.
  it('returns a deterministic estimated usage alongside the embedding', async () => {
    const generator = new MockEmbeddingGenerator();
    const result = await generator.generate('a claim about a vehicle collision');

    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBe(0);
  });

  it('returns a promise, satisfying the EmbeddingGenerator interface', () => {
    const generator = new MockEmbeddingGenerator();
    const result = generator.generate('some text');

    expect(result).toBeInstanceOf(Promise);
  });
});
