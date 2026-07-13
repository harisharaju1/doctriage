-- Week 2, Day 1 schema — migration 001.
--
-- This is Day 1's original schema.sql, unchanged, moved here as the first
-- entry in an ordered migrations directory. As of Week 2 Day 3, migrate.ts
-- tracks which migrations have already run in a `schema_migrations` table,
-- so this file only ever executes once per database, ever — not on every
-- app startup the way the old single-schema.sql approach worked. See
-- migrate.ts's header comment for why that changed (short version: a second
-- migration arrived — 002_titan_v2_dimension.sql — that needs to ALTER an
-- existing column, which "CREATE ... IF NOT EXISTS" can't express).
--
-- Every statement here is still written to be idempotent regardless, as
-- defense in depth — safe even if this file were somehow re-run.

-- pgvector ships as a Postgres *extension* — it's bundled inside the
-- `pgvector/pgvector:pg16` Docker image we've been running since Week 1 Day 6,
-- but an extension still has to be explicitly turned on per-database before
-- its types (like `vector`) and operators (like `<=>`) exist. This is a
-- one-time "activate the feature" step, not something that installs new code.
CREATE EXTENSION IF NOT EXISTS vector;

-- One row per chunk of extracted document text, plus the embedding vector
-- that represents that chunk's meaning.
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  -- gen_random_uuid() is built into Postgres 13+ (no extra extension needed
  -- on our pg16 image) and generates a random UUID as the default value for
  -- any row that doesn't specify one explicitly.
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Deliberately NOT a foreign key. Document records currently live in an
  -- in-memory Map (see src/repositories/inMemoryDocumentRepository.ts), not
  -- in Postgres — there is no `documents` table here to reference, and SQL
  -- foreign keys can't point across separate databases anyway. This is a
  -- "soft" reference: the same UUID the document was assigned on upload is
  -- reused here by convention, but nothing in the database enforces that it
  -- points at something real. Normal tradeoff once data is split across
  -- multiple stores (Postgres for vectors, Mongo for documents later).
  document_id  uuid NOT NULL,

  -- Which chunk, in order, this row represents within its parent document
  -- (0, 1, 2, ...).
  chunk_index  integer NOT NULL,

  -- The raw text this embedding represents. Storing it alongside the vector
  -- (rather than just an ID pointing elsewhere) means a similarity search can
  -- return the actual matching text directly, with no second lookup.
  chunk_text   text NOT NULL,

  -- pgvector's custom column type. vector(1536) means "a fixed-length list of
  -- 1536 floating point numbers." 1536 was Day 1's initial guess at the real
  -- embedding model's output dimension — corrected in migration 002 once the
  -- real model (Titan Text Embeddings V2) turned out to use a different size.
  embedding    vector(1536) NOT NULL,

  created_at   timestamptz NOT NULL DEFAULT now()
);

-- A plain B-tree index on document_id — this speeds up "give me all chunks
-- for this document" lookups. This is NOT a vector similarity index — see
-- Day 1's original notes (docs/week-2-day-1.md) for why an ANN index
-- (ivfflat/hnsw) is deliberately deferred until real document volume exists.
CREATE INDEX IF NOT EXISTS chunk_embeddings_document_id_idx
  ON chunk_embeddings (document_id);
