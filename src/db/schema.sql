-- Week 2, Day 1 schema.
--
-- This file is executed by src/db/migrate.ts every time the app starts.
-- Every statement here is written to be *idempotent* — safe to run over and
-- over against the same database without erroring or duplicating anything.
-- That's what lets us skip a real migration framework (no Flyway, no
-- node-pg-migrate, no EF-Core-style migration history table) for now: there's
-- exactly one migration, and "run this SQL, it's a no-op if already applied"
-- is simpler and just as correct as versioned migrations for a single step.

-- pgvector ships as a Postgres *extension* — it's bundled inside the
-- `pgvector/pgvector:pg16` Docker image we've been running since Week 1 Day 6,
-- but an extension still has to be explicitly turned on per-database before
-- its types (like `vector`) and operators (like `<=>`) exist. This is a
-- one-time "activate the feature" step, not something that installs new code.
CREATE EXTENSION IF NOT EXISTS vector;

-- One row per chunk of extracted document text, plus the embedding vector
-- that represents that chunk's meaning. Chunking itself (splitting a
-- document's full text into these smaller pieces) is Day 2's job — today we
-- only need the table to exist so we can prove insert + similarity search
-- works, using a handful of hand-inserted test rows.
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
  -- (0, 1, 2, ...). Needed once Day 2 splits a document into many chunks and
  -- we want to reconstruct order or show "which part of the document" a
  -- retrieved match came from.
  chunk_index  integer NOT NULL,

  -- The raw text this embedding represents. Storing it alongside the vector
  -- (rather than just an ID pointing elsewhere) means a similarity search can
  -- return the actual matching text directly, with no second lookup.
  chunk_text   text NOT NULL,

  -- pgvector's custom column type. vector(1536) means "a fixed-length list of
  -- 1536 floating point numbers" — Postgres will reject any insert that
  -- doesn't have exactly 1536 values. 1536 is chosen now (not an arbitrary
  -- round number) because it matches Amazon Titan Embeddings v2's typical
  -- output dimension — the real embedding model we're wiring in on Day 3.
  -- Picking the real dimension today means this schema doesn't need to
  -- change later when the mock embedding generator (src/services/embedding.ts)
  -- is swapped for a real Bedrock call.
  embedding    vector(1536) NOT NULL,

  created_at   timestamptz NOT NULL DEFAULT now()
);

-- A plain B-tree index on document_id — this speeds up "give me all chunks
-- for this document" lookups (e.g. when re-embedding or deleting a document's
-- chunks). This is NOT a vector similarity index. A similarity-search index
-- (ivfflat or hnsw, built on the `embedding` column) would speed up nearest-
-- neighbor queries on large tables, but with only a handful of test rows a
-- full sequential scan is already instant and exact — adding an ANN index now
-- would be optimizing something that isn't slow yet. Revisit once Day 2+
-- populates real document volume.
CREATE INDEX IF NOT EXISTS chunk_embeddings_document_id_idx
  ON chunk_embeddings (document_id);
