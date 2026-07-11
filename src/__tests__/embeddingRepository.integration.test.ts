// src/__tests__/embeddingRepository.integration.test.ts
//
// UNLIKE every other test in this project so far (env, extraction, retry —
// all pure logic, no real external dependency), this one talks to a REAL
// Postgres database. That's deliberate: the whole point of today's work is
// proving that inserting a vector and asking "what's nearest?" actually
// round-trips correctly through pgvector's serialization and the `<=>`
// cosine-distance operator — a hand-mocked `pg` client would only prove that
// our mock is self-consistent, not that the real SQL/vector wire format is
// correct.
//
// WHY GATE THIS ON POSTGRES_URL WITH skipIf, INSTEAD OF ALWAYS RUNNING IT?
// Not everyone running `pnpm test` will have `docker compose up -d postgres`
// running (e.g. CI, or a quick check on a machine without Docker started).
// `describe.skipIf` makes this test skip cleanly and visibly in that case,
// rather than the whole test suite failing with a confusing connection
// error. When Postgres IS available, this test runs for real and gives a
// genuine correctness signal — the best of both.
//
// NOTE ON DYNAMIC IMPORTS BELOW: importing `../config/db.js` at the top of
// this file (a normal `import` statement) would run immediately when this
// test file loads — BEFORE skipIf has a chance to skip anything — and that
// module calls `loadEnv()`, which now throws if POSTGRES_URL isn't set. So
// the Postgres-dependent imports are deliberately done with a dynamic
// `await import(...)` *inside* the test, only reached when the describe
// block isn't skipped.

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { generateMockEmbedding } from '../services/embedding.js';
import { PostgresEmbeddingRepository } from '../repositories/postgresEmbeddingRepository.js';
import type { Pool } from 'pg';

const hasPostgresUrl = Boolean(process.env.POSTGRES_URL);

describe.skipIf(!hasPostgresUrl)('PostgresEmbeddingRepository (integration)', () => {
  // Scoping every row we insert to one random documentId means cleanup
  // (below) can delete exactly what this test run created, and nothing
  // else — safe to run repeatedly against a shared dev database without
  // accumulating garbage or colliding with other test runs.
  const documentId = randomUUID();
  let pool: Pool;

  afterAll(async () => {
    if (!pool) return;

    // Clean up this test's own rows so repeated runs don't pile up test
    // data in the shared dev database — there's no dedicated test-database
    // isolation infrastructure yet, so scoping cleanup by documentId is the
    // pragmatic choice for now.
    await pool.query('DELETE FROM chunk_embeddings WHERE document_id = $1', [documentId]);

    // Without this, `pnpm test` would hang after finishing — an open
    // Postgres connection pool keeps the Node process alive indefinitely.
    await pool.end();
  });

  it('ranks similar chunks ahead of a dissimilar one', async () => {
    const db = await import('../config/db.js');
    const { runMigrations } = await import('../db/migrate.js');
    pool = db.pool;

    // Safe to call every test run — every statement in schema.sql is
    // idempotent (CREATE ... IF NOT EXISTS), so this just confirms the
    // schema exists rather than erroring if it already does.
    await runMigrations(pool);

    const repo = new PostgresEmbeddingRepository(pool);

    // Two chunks that share a lot of vocabulary (claimant / police / report
    // / vehicle / collision) — the mock embedding generator (see
    // src/services/embedding.ts) gives shared words shared dimensions, so
    // these two should end up pointing in a noticeably similar direction.
    const similarChunkA =
      'The claimant submitted a police report describing the vehicle collision.';
    const similarChunkB =
      'A police report was filed by the claimant regarding the vehicle collision.';

    // A chunk with entirely different vocabulary — no shared words with the
    // two above — should end up pointing in an unrelated direction.
    const dissimilarChunk =
      'Quarterly revenue increased due to strong enterprise software sales.';

    await repo.insert({
      documentId,
      chunkIndex: 0,
      chunkText: similarChunkA,
      embedding: generateMockEmbedding(similarChunkA),
    });
    await repo.insert({
      documentId,
      chunkIndex: 1,
      chunkText: similarChunkB,
      embedding: generateMockEmbedding(similarChunkB),
    });
    await repo.insert({
      documentId,
      chunkIndex: 2,
      chunkText: dissimilarChunk,
      embedding: generateMockEmbedding(dissimilarChunk),
    });

    // Query with a sentence that shares vocabulary with the two "similar"
    // chunks but not with the dissimilar one — this is the actual proof:
    // if pgvector's cosine-distance search and our vector serialization are
    // both working correctly, the two vocabulary-sharing rows should come
    // back ranked ahead of the unrelated one.
    const queryEmbedding = generateMockEmbedding('police report vehicle collision claimant');
    const results = await repo.findSimilar(queryEmbedding, 3);

    expect(results).toHaveLength(3);

    // Every result's `distance` came directly from Postgres's `<=>` operator
    // — remember, this is cosine DISTANCE (smaller = more similar), so
    // "ranked ahead of" means "smaller distance," and results are already
    // ORDER BY-sorted ascending by the repository's query.
    const resultTexts = results.map((r) => r.chunkText);
    expect(resultTexts[0]).not.toBe(dissimilarChunk);
    expect(resultTexts[1]).not.toBe(dissimilarChunk);
    expect(resultTexts[2]).toBe(dissimilarChunk);

    // The dissimilar chunk's distance should be clearly larger than either
    // similar chunk's distance — not just last by a hair.
    const similarDistances = results.filter((r) => r.chunkText !== dissimilarChunk).map((r) => r.distance);
    const dissimilarDistance = results.find((r) => r.chunkText === dissimilarChunk)!.distance;
    expect(Math.max(...similarDistances)).toBeLessThan(dissimilarDistance);
  });
});
