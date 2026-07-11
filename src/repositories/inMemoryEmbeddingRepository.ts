// src/repositories/inMemoryEmbeddingRepository.ts
//
// An in-memory implementation of EmbeddingRepository — mirrors
// InMemoryDocumentRepository's role: a fast, dependency-free stand-in for
// the real Postgres-backed implementation, useful anywhere a real database
// isn't the point of what's being tested. This is the actual payoff of
// having built EmbeddingRepository as an interface in Day 1/2: route-level
// tests (documents.routes.test.ts) can exercise the full upload → classify →
// embed → query → batch flow with zero Docker/Postgres dependency, because
// the routes only ever depend on the EmbeddingRepository interface, never on
// PostgresEmbeddingRepository directly.
//
// The one thing this class has to do that PostgresEmbeddingRepository gets
// for free from pgvector's `<=>` operator is compute cosine distance itself,
// in plain JavaScript — see cosineDistance() below.

import { randomUUID } from 'node:crypto';
import type { ChunkEmbeddingRecord, EmbeddingRepository } from './embeddingRepository.js';

function cosineDistance(a: number[], b: number[]): number {
  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i++) {
    const aValue = a[i]!;
    const bValue = b[i]!;
    dotProduct += aValue * bValue;
    magnitudeA += aValue * aValue;
    magnitudeB += bValue * bValue;
  }

  const magnitude = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
  // Cosine SIMILARITY is dotProduct / magnitude, ranging -1..1 (1 = identical
  // direction). Cosine DISTANCE — what pgvector's `<=>` operator returns, and
  // what this function needs to match — is 1 minus that, so smaller means
  // more similar, exactly like the real implementation.
  const similarity = magnitude === 0 ? 0 : dotProduct / magnitude;
  return 1 - similarity;
}

export class InMemoryEmbeddingRepository implements EmbeddingRepository {
  private readonly store: ChunkEmbeddingRecord[] = [];

  async insert(
    record: Omit<ChunkEmbeddingRecord, 'id' | 'createdAt'>,
  ): Promise<ChunkEmbeddingRecord> {
    const full: ChunkEmbeddingRecord = { ...record, id: randomUUID(), createdAt: new Date() };
    this.store.push(full);
    return full;
  }

  async findSimilar(
    embedding: number[],
    limit: number,
  ): Promise<Array<ChunkEmbeddingRecord & { distance: number }>> {
    return this.rankBySimilarity(this.store, embedding, limit);
  }

  async findSimilarInDocument(
    documentId: string,
    embedding: number[],
    limit: number,
  ): Promise<Array<ChunkEmbeddingRecord & { distance: number }>> {
    const scoped = this.store.filter((row) => row.documentId === documentId);
    return this.rankBySimilarity(scoped, embedding, limit);
  }

  async replaceChunksForDocument(
    documentId: string,
    chunks: Array<Omit<ChunkEmbeddingRecord, 'id' | 'createdAt' | 'documentId'>>,
  ): Promise<ChunkEmbeddingRecord[]> {
    // Mirrors the real implementation's atomicity intent (delete-then-insert
    // as one logical step) — there's no concurrent access to race against in
    // a single in-memory array the way there is with a real connection pool,
    // so a literal BEGIN/COMMIT transaction has nothing to protect against
    // here, but the *behavior* (old rows gone, new rows in) matches exactly.
    this.removeChunksForDocument(documentId);

    const inserted: ChunkEmbeddingRecord[] = [];
    for (const chunk of chunks) {
      inserted.push(await this.insert({ ...chunk, documentId }));
    }
    return inserted;
  }

  async countChunksForDocument(documentId: string): Promise<number> {
    return this.store.filter((row) => row.documentId === documentId).length;
  }

  private removeChunksForDocument(documentId: string): void {
    for (let i = this.store.length - 1; i >= 0; i--) {
      if (this.store[i]!.documentId === documentId) {
        this.store.splice(i, 1);
      }
    }
  }

  private rankBySimilarity(
    rows: ChunkEmbeddingRecord[],
    embedding: number[],
    limit: number,
  ): Array<ChunkEmbeddingRecord & { distance: number }> {
    return rows
      .map((row) => ({ ...row, distance: cosineDistance(row.embedding, embedding) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }
}
