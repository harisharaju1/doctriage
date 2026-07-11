// src/repositories/postgresEmbeddingRepository.ts
//
// The real, Postgres-backed implementation of EmbeddingRepository. This is
// where the actual SQL lives.

import type { Pool } from 'pg';
import pgvector from 'pgvector/pg';
import type { ChunkEmbeddingRecord, EmbeddingRepository } from './embeddingRepository.js';

// The raw shape a full row comes back as from `pg` — snake_case column
// names, and `embedding` arrives as a plain number[] because src/config/db.ts
// registered pgvector's type parser on every connection this pool opens.
// Only findSimilar() below uses this — it genuinely needs every column, since
// it's returning rows the caller hasn't seen before. insert() doesn't use it:
// see the comment in insert() for why it only asks Postgres for two columns,
// not the full row.
interface ChunkEmbeddingRow {
  id: string;
  document_id: string;
  chunk_index: number;
  chunk_text: string;
  embedding: number[];
  created_at: Date;
}

function toRecord(row: ChunkEmbeddingRow): ChunkEmbeddingRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    chunkIndex: row.chunk_index,
    chunkText: row.chunk_text,
    embedding: row.embedding,
    createdAt: row.created_at,
  };
}

export class PostgresEmbeddingRepository implements EmbeddingRepository {
  constructor(private readonly pool: Pool) {}

  async insert(
    record: Omit<ChunkEmbeddingRecord, 'id' | 'createdAt'>,
  ): Promise<ChunkEmbeddingRecord> {
    // Parameterized query ($1, $2, ...) rather than string-concatenating
    // values into the SQL text — this is what prevents SQL injection.
    // `record.chunkText` came from a real PDF's extracted text; treating it
    // as a *parameter value* (not as SQL source) means it can never be
    // interpreted as SQL no matter what characters it contains.
    //
    // pgvector.toSql() converts our plain `number[]` into the literal string
    // format Postgres's `vector` type expects on the wire (e.g. "[0.1,0.2,...]").
    // Note this is a ONE-WAY conversion we have to do ourselves: the
    // registerTypes() call in src/config/db.ts only teaches `pg` how to parse
    // a `vector` value coming BACK from a query (see findSimilar below) — it
    // does not teach `pg` how to serialize a JS array going INTO a query, so
    // outbound vectors still need this explicit conversion.
    //
    // RETURNING id, created_at — deliberately NOT `RETURNING *`. Of the six
    // columns on this table, Postgres itself only generates two: `id` and
    // `created_at` (via the DEFAULTs in schema.sql — gen_random_uuid(),
    // now()). The other four are values we already have sitting in `record`,
    // the parameter we just sent in. Asking Postgres to hand all of them
    // back with `RETURNING *` would mean paying to round-trip data we
    // already hold in memory — worst of all the `embedding` column, a
    // 1536-float vector, which is a genuinely expensive value to send back
    // over the wire for no reason. Naming exactly the two columns we need
    // also fails loudly (a clear SQL error) if either is ever renamed in a
    // future migration, instead of `RETURNING *` silently returning
    // whatever's there.
    const result = await this.pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO chunk_embeddings (document_id, chunk_index, chunk_text, embedding)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [record.documentId, record.chunkIndex, record.chunkText, pgvector.toSql(record.embedding)],
    );

    // A single-row INSERT's RETURNING clause always returns exactly one row
    // — asserting non-null here (rather than an `if` + throw) documents that
    // guarantee instead of treating it as a real runtime possibility to
    // handle. `rows[0]` is typed as `{ id, created_at } | undefined` by
    // TypeScript's noUncheckedIndexedAccess, hence the `!`.
    const generated = result.rows[0]!;

    // Build the full record by combining what we already knew (`record`)
    // with the two values only Postgres could tell us (`generated`) — no
    // second query, no re-parsing a full row we already had the pieces of.
    return { ...record, id: generated.id, createdAt: generated.created_at };
  }

  async findSimilar(
    embedding: number[],
    limit: number,
  ): Promise<Array<ChunkEmbeddingRecord & { distance: number }>> {
    // pgvector's `<=>` operator computes COSINE DISTANCE between two
    // vectors — NOT cosine similarity. This is the single easiest thing to
    // get backwards:
    //   - distance: 0 = identical direction ("same meaning"), larger = more
    //     different. This is what `<=>` gives us.
    //   - similarity: 1 = identical, 0 = unrelated. This is the OPPOSITE
    //     scale, and is what `<=>` does NOT give us.
    // Because we're working with distance, "most similar" means "smallest
    // number" — so we ORDER BY ascending (Postgres's default) to get the
    // closest matches first, not descending.
    //
    // The embedding parameter is passed twice ($1 appears in both the SELECT
    // list and the ORDER BY) — Postgres computes it once per row and reuses
    // it, so this isn't computing the distance twice per row; it's just SQL
    // syntax requiring the expression to be written out.
    const result = await this.pool.query<ChunkEmbeddingRow & { distance: number }>(
      `SELECT *, embedding <=> $1 AS distance
       FROM chunk_embeddings
       ORDER BY embedding <=> $1
       LIMIT $2`,
      [pgvector.toSql(embedding), limit],
    );

    return result.rows.map((row) => ({ ...toRecord(row), distance: row.distance }));
  }

  async findSimilarInDocument(
    documentId: string,
    embedding: number[],
    limit: number,
  ): Promise<Array<ChunkEmbeddingRecord & { distance: number }>> {
    // Same cosine-distance query as findSimilar above, with one addition:
    // `WHERE document_id = $2`. This is pushed into the SQL itself — not
    // applied as a client-side `.filter()` after fetching a global top-K —
    // for two reasons (see docs/week-2-day-2.md for the full explanation):
    //
    // 1. CORRECTNESS: a global top-K search could return zero rows from
    //    this document at all, if other documents' chunks happen to rank
    //    higher. Filtering afterward can't recover chunks that were never
    //    fetched in the first place.
    // 2. EFFICIENCY: schema.sql's chunk_embeddings_document_id_idx (added
    //    Day 1, specifically anticipating this) lets Postgres narrow down to
    //    this document's rows BEFORE computing any distance calculations,
    //    instead of scoring every row in the whole table and discarding
    //    most of the results.
    const result = await this.pool.query<ChunkEmbeddingRow & { distance: number }>(
      `SELECT *, embedding <=> $1 AS distance
       FROM chunk_embeddings
       WHERE document_id = $2
       ORDER BY embedding <=> $1
       LIMIT $3`,
      [pgvector.toSql(embedding), documentId, limit],
    );

    return result.rows.map((row) => ({ ...toRecord(row), distance: row.distance }));
  }

  async replaceChunksForDocument(
    documentId: string,
    chunks: Array<Omit<ChunkEmbeddingRecord, 'id' | 'createdAt' | 'documentId'>>,
  ): Promise<ChunkEmbeddingRecord[]> {
    // A transaction needs to run on ONE dedicated connection, not through
    // the pool's normal "grab whichever connection is free" behavior —
    // BEGIN/COMMIT only mean something within a single connection's session.
    // `pool.connect()` checks out one client and holds it for exclusive use
    // until we're done with it (`client.release()` in the `finally` below).
    const client = await this.pool.connect();

    try {
      // BEGIN starts a transaction: none of the writes below become visible
      // to any other connection (or durable on disk) until COMMIT succeeds.
      // If anything throws before COMMIT, the catch block below runs
      // ROLLBACK, which undoes every write since BEGIN — so a crash or error
      // partway through can never leave this document with a half-deleted,
      // half-inserted set of chunks. See docs/week-2-day-2.md's "database
      // transactions" section for the full reasoning (this is the same
      // atomicity guarantee as wrapping multiple SaveChanges() calls in a
      // .NET TransactionScope).
      await client.query('BEGIN');

      await client.query('DELETE FROM chunk_embeddings WHERE document_id = $1', [documentId]);

      const inserted: ChunkEmbeddingRecord[] = [];
      for (const chunk of chunks) {
        const result = await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO chunk_embeddings (document_id, chunk_index, chunk_text, embedding)
           VALUES ($1, $2, $3, $4)
           RETURNING id, created_at`,
          [documentId, chunk.chunkIndex, chunk.chunkText, pgvector.toSql(chunk.embedding)],
        );
        const generated = result.rows[0]!;
        inserted.push({
          ...chunk,
          documentId,
          id: generated.id,
          createdAt: generated.created_at,
        });
      }

      await client.query('COMMIT');
      return inserted;
    } catch (err) {
      // Best-effort rollback — if the connection itself died (rather than
      // the query merely failing), this ROLLBACK will also fail, but at that
      // point the transaction was never going to commit anyway, so we
      // deliberately let the original error propagate rather than masking it
      // with a rollback failure.
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      // Always return the client to the pool, whether the transaction
      // succeeded or failed — without this, a failed transaction would leak
      // a connection out of the pool permanently, and the pool would
      // eventually run out of connections to hand to anyone else.
      client.release();
    }
  }

  async countChunksForDocument(documentId: string): Promise<number> {
    // COUNT(*) returns a Postgres `bigint`, which node-postgres deserializes
    // as a *string* by default (a JS `number` can't safely represent every
    // possible bigint value) — so this needs an explicit Number() conversion
    // rather than trusting the driver to hand back a number directly. Safe
    // here because a chunk count per document will never be anywhere close
    // to Number.MAX_SAFE_INTEGER.
    const result = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*) FROM chunk_embeddings WHERE document_id = $1',
      [documentId],
    );
    return Number(result.rows[0]!.count);
  }
}
