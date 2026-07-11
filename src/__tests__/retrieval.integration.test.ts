// src/__tests__/retrieval.integration.test.ts
//
// Day 1's embeddingRepository.integration.test.ts already proved that
// pgvector's cosine-distance ranking works correctly in general — similar
// text ranks ahead of dissimilar text. What it did NOT prove is document
// SCOPING: that a query run against one document never returns chunks that
// happen to belong to a different document, even when that other
// document's chunks are a better semantic match. That's the specific,
// previously-untested correctness property this file exists to check — see
// the "why does retrieval need to be scoped to one document?" section of
// docs/week-2-day-2.md for why an unscoped search is actively wrong once
// more than one document's chunks share the table.
//
// Same skip/dynamic-import pattern as Day 1's integration test — see that
// file's header comment for the full reasoning (short version: importing
// ../config/db.js at the top of this file would run loadEnv() immediately,
// before skipIf gets a chance to skip anything, and that throws if
// POSTGRES_URL isn't set).

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresEmbeddingRepository } from '../repositories/postgresEmbeddingRepository.js';
import { findRelevantChunks } from '../services/retrieval.js';
import { generateMockEmbedding } from '../services/embedding.js';
import type { Pool } from 'pg';

const hasPostgresUrl = Boolean(process.env.POSTGRES_URL);

describe.skipIf(!hasPostgresUrl)('findRelevantChunks (integration)', () => {
  // Two distinct documentIds, each scoped to their own cleanup — this test's
  // whole point is proving these two documents' chunks don't bleed into
  // each other's search results, so keeping them clearly separate here
  // mirrors what the code under test is supposed to guarantee.
  const documentAId = randomUUID();
  const documentBId = randomUUID();
  let pool: Pool;

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM chunk_embeddings WHERE document_id = ANY($1)', [
      [documentAId, documentBId],
    ]);
    await pool.end();
  });

  it('never returns chunks from a different document, even when they are a closer semantic match', async () => {
    const db = await import('../config/db.js');
    const { runMigrations } = await import('../db/migrate.js');
    pool = db.pool;
    await runMigrations(pool);

    const repo = new PostgresEmbeddingRepository(pool);

    // Document A is ABOUT the topic we're going to ask about (police
    // reports / vehicle collisions) — but every individual chunk uses
    // slightly different phrasing than the query, so it won't be a perfect
    // vocabulary match.
    await repo.replaceChunksForDocument(documentAId, [
      {
        chunkIndex: 0,
        chunkText: 'The incident occurred at an intersection involving two vehicles.',
        embedding: generateMockEmbedding(
          'The incident occurred at an intersection involving two vehicles.',
        ),
      },
      {
        chunkIndex: 1,
        chunkText: 'Responding officers documented the scene and interviewed witnesses.',
        embedding: generateMockEmbedding(
          'Responding officers documented the scene and interviewed witnesses.',
        ),
      },
    ]);

    // Document B is a COMPLETELY UNRELATED topic (revenue/sales) — but one
    // of its chunks shares heavy vocabulary overlap with the query below
    // (police / report / vehicle / collision / claimant), which the
    // hashing-trick mock embedding generator (src/services/embedding.ts)
    // will make a near-perfect vocabulary match — better, in fact, than
    // anything in document A. This is the deliberate trap: an unscoped
    // search would likely surface this chunk first. A correctly scoped
    // search must never return it when we ask specifically about document A.
    //
    // (Deliberately NOT the exact same phrase as the query text below —
    // embeddingRepository.integration.test.ts also queries with that exact
    // phrase, and vitest runs test files in parallel against the same live
    // database, so an identical string here would create a cross-test-file
    // collision. Close vocabulary overlap is enough to prove the point
    // without that collision.)
    await repo.replaceChunksForDocument(documentBId, [
      {
        chunkIndex: 0,
        chunkText: 'Quarterly revenue increased due to strong enterprise software sales.',
        embedding: generateMockEmbedding(
          'Quarterly revenue increased due to strong enterprise software sales.',
        ),
      },
      {
        chunkIndex: 1,
        chunkText: 'A police report about the vehicle collision named the claimant directly.',
        embedding: generateMockEmbedding(
          'A police report about the vehicle collision named the claimant directly.',
        ),
      },
    ]);

    const matches = await findRelevantChunks(
      repo,
      documentAId,
      'police report vehicle collision claimant',
      5,
    );

    // Every match must belong to document A — this is the actual proof.
    // Without the WHERE document_id = ... filter in
    // findSimilarInDocument's SQL, document B's vocabulary-overlapping
    // chunk would have won this search outright.
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.documentId === documentAId)).toBe(true);
    expect(matches.some((m) => m.chunkText.includes('Quarterly revenue'))).toBe(false);
    expect(matches.some((m) => m.chunkText.includes('named the claimant directly'))).toBe(false);
  });
});
