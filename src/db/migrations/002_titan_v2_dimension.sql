-- Week 2, Day 3 — migration 002.
--
-- WHY THIS MIGRATION EXISTS: migration 001 guessed `vector(1536)` for the
-- embedding column, based on a mistaken assumption about which Titan
-- Embeddings generation Bedrock offers. The actual, and only, Titan
-- text-embedding model currently in Bedrock's catalog is Titan Text
-- Embeddings V2 (amazon.titan-embed-text-v2:0), which outputs 1024
-- dimensions by default (configurable to 256/512/1024) — not 1536. See
-- docs/week-2-day-3.md's "UPDATE — Option A is not available" section for
-- the full story of how this was discovered.
--
-- WHY A PLAIN ALTER COLUMN, NOT A BACKFILL: every row in chunk_embeddings so
-- far is Day 1/2 mock/test data — today (Week 2 Day 3) is the FIRST time any
-- real embedding gets generated in this project at all. There is no real
-- production data whose meaning would be lost by this migration, which is
-- exactly why "truncate, then change the column type" is a safe, honest
-- migration here. A real production migration changing an embedding
-- dimension on a table with genuine data would need a backfill plan
-- instead (re-embed every existing row under the new model before or during
-- the cutover) — worth knowing that distinction exists even though this
-- project doesn't need to build it today.
--
-- WHY TRUNCATE IS SAFE TO RUN AS PART OF AN "IF NOT ALREADY APPLIED"
-- MIGRATION: migrate.ts (see its header comment) only ever runs this file
-- ONCE per database, ever, tracked via the schema_migrations table below —
-- not on every app startup the way migration 001 used to run its single
-- schema.sql. So this TRUNCATE cannot silently re-fire and wipe real data on
-- a later restart; it fires exactly once, the first time this migration is applied.

TRUNCATE chunk_embeddings;

ALTER TABLE chunk_embeddings
  ALTER COLUMN embedding TYPE vector(1024);
