import { describe, expect, it } from 'vitest';
import { InMemoryEmbeddingRepository } from '../repositories/inMemoryEmbeddingRepository.js';

describe('InMemoryEmbeddingRepository', () => {
  it('inserts a chunk and returns it with a generated id and createdAt', async () => {
    const repo = new InMemoryEmbeddingRepository();

    const record = await repo.insert({
      documentId: 'doc-1',
      chunkIndex: 0,
      chunkText: 'hello world',
      embedding: [1, 0, 0],
    });

    expect(record.id).toBeTruthy();
    expect(record.createdAt).toBeInstanceOf(Date);
    expect(record.documentId).toBe('doc-1');
  });

  it('findSimilar ranks by cosine distance ascending, across all documents', async () => {
    const repo = new InMemoryEmbeddingRepository();
    await repo.insert({ documentId: 'a', chunkIndex: 0, chunkText: 'same direction', embedding: [1, 0, 0] });
    await repo.insert({ documentId: 'b', chunkIndex: 0, chunkText: 'opposite direction', embedding: [-1, 0, 0] });
    await repo.insert({ documentId: 'c', chunkIndex: 0, chunkText: 'orthogonal', embedding: [0, 1, 0] });

    const results = await repo.findSimilar([1, 0, 0], 3);

    expect(results.map((r) => r.chunkText)).toEqual(['same direction', 'orthogonal', 'opposite direction']);
    // Identical direction → distance 0; opposite direction → distance 2
    // (cosine similarity -1, so 1 - (-1) = 2) — exact values worth pinning
    // down since they prove the formula matches pgvector's `<=>` scale.
    expect(results[0]!.distance).toBeCloseTo(0);
    expect(results.at(-1)!.distance).toBeCloseTo(2);
  });

  it('findSimilarInDocument never returns rows from a different document', async () => {
    const repo = new InMemoryEmbeddingRepository();
    await repo.insert({ documentId: 'a', chunkIndex: 0, chunkText: 'in doc a', embedding: [1, 0, 0] });
    await repo.insert({ documentId: 'b', chunkIndex: 0, chunkText: 'in doc b, closer match', embedding: [1, 0, 0] });

    const results = await repo.findSimilarInDocument('a', [1, 0, 0], 5);

    expect(results).toHaveLength(1);
    expect(results[0]!.documentId).toBe('a');
  });

  it('replaceChunksForDocument removes prior chunks for that document and inserts the new set', async () => {
    const repo = new InMemoryEmbeddingRepository();
    await repo.insert({ documentId: 'a', chunkIndex: 0, chunkText: 'stale chunk', embedding: [1, 0, 0] });
    await repo.insert({ documentId: 'b', chunkIndex: 0, chunkText: 'untouched, different document', embedding: [0, 1, 0] });

    await repo.replaceChunksForDocument('a', [
      { chunkIndex: 0, chunkText: 'fresh chunk one', embedding: [1, 0, 0] },
      { chunkIndex: 1, chunkText: 'fresh chunk two', embedding: [0, 0, 1] },
    ]);

    const aChunks = await repo.findSimilarInDocument('a', [1, 0, 0], 10);
    const bChunks = await repo.findSimilarInDocument('b', [0, 1, 0], 10);

    expect(aChunks.map((c) => c.chunkText).sort()).toEqual(['fresh chunk one', 'fresh chunk two']);
    expect(bChunks).toHaveLength(1);
    expect(bChunks[0]!.chunkText).toBe('untouched, different document');
  });

  it('countChunksForDocument reflects inserts and replaces accurately', async () => {
    const repo = new InMemoryEmbeddingRepository();
    expect(await repo.countChunksForDocument('a')).toBe(0);

    await repo.insert({ documentId: 'a', chunkIndex: 0, chunkText: 'one', embedding: [1, 0, 0] });
    expect(await repo.countChunksForDocument('a')).toBe(1);

    await repo.replaceChunksForDocument('a', [
      { chunkIndex: 0, chunkText: 'one', embedding: [1, 0, 0] },
      { chunkIndex: 1, chunkText: 'two', embedding: [0, 1, 0] },
      { chunkIndex: 2, chunkText: 'three', embedding: [0, 0, 1] },
    ]);
    expect(await repo.countChunksForDocument('a')).toBe(3);
  });
});
