// src/db/migrate.ts
//
// A small, real migration runner — replaces Week 2 Day 1's original design
// (one big idempotent schema.sql, re-executed in full on every app startup)
// with an ordered directory of migration files, each applied AT MOST ONCE
// PER DATABASE, tracked in a `schema_migrations` table.
//
// WHY THIS CHANGED FROM DAY 1'S APPROACH
// Day 1's own note already named the trigger for this: "a real migration
// tool is the natural next step once there's a second migration to manage."
// Week 2 Day 3 IS that second migration (002_titan_v2_dimension.sql changes
// chunk_embeddings.embedding's dimension) — and it exposed a real limit of
// the old approach: `CREATE TABLE IF NOT EXISTS` is a no-op against a table
// that already exists, so it has NO WAY to express "also change this
// existing column's type." Re-running the same schema.sql every startup
// only ever worked because every statement in it happened to be pure
// "create if missing" — the moment a migration needs to ALTER something
// that might already exist in a different shape, "run the whole file every
// time" stops being safe, and per-migration tracking becomes necessary, not
// just nicer.
//
// WHY NOT A FULL MIGRATION FRAMEWORK (Flyway, node-pg-migrate, EF-Core-style
// Up()/Down() with rollback)?
// Two migrations is still a small enough number that a real framework would
// be more machinery than the problem justifies — this project doesn't need
// rollback support, branching migrations, or a CLI. It needs exactly one
// thing a single schema.sql couldn't give it: "has this specific migration
// already run?" A one-column tracking table plus a loop over a sorted
// directory answers that completely. Worth revisiting once there are enough
// migrations that manually managing filenames/ordering gets unwieldy, or
// once a real rollback story is actually needed — neither is true yet.
//
// WHY AN ADVISORY LOCK — A REAL BUG FOUND WHILE IMPLEMENTING THIS
// This project's own test suite runs multiple integration test files that
// each independently call runMigrations() against the same live Postgres —
// and vitest runs test FILES in parallel, each in its own worker
// process/thread with its own module registry, so each one ends up with its
// own `pool` instance rather than sharing Day 1's "one shared pool" singleton
// across the whole test run. The result: two processes can call
// runMigrations() against a genuinely brand-new database at the same
// moment, and `CREATE EXTENSION IF NOT EXISTS` / `CREATE TABLE IF NOT
// EXISTS` are NOT safe against true concurrent execution from separate
// connections — both can check "does this exist?", both see "no," and both
// attempt to create it, and one loses with a duplicate-key error on
// Postgres's internal catalog (pg_type, since every CREATE TABLE implicitly
// registers a matching row type there too). This isn't just a test-suite
// quirk — the identical race would happen in production if multiple app
// replicas ever started at the same instant against a fresh database.
//
// The fix is a Postgres advisory lock (pg_advisory_lock) — a session-level
// lock that works across separate connections/processes, exactly for
// serializing "only one of you gets to run migrations right now" the way
// real migration tools (Flyway, golang-migrate, Rails) all do internally.
// Whoever loses the race simply waits, then finds every migration already
// applied and does nothing — no error, no duplicate work.
//
// .NET parallel: this is now much closer to EF Core Migrations' actual
// mental model than Day 1's version was — a migration history table
// (`__EFMigrationsHistory` in EF Core, `schema_migrations` here) records
// which migrations have run, and `dotnet ef database update` (here,
// `runMigrations()`) applies whatever's missing, in order. The advisory
// lock plays the same role SQL Server's `sp_getapplock` (or a distributed
// lease) would play in a .NET deployment where multiple instances might
// try to migrate the same database concurrently on startup.

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg, { type Pool } from 'pg';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// An arbitrary but FIXED 64-bit-safe integer, shared by every process that
// might ever run migrations against this database. Postgres advisory locks
// are identified by a plain number, not a name — any consistent constant
// works, since its only job is to be the same value every time this
// function is called, so concurrent callers are all contending for the
// exact same lock.
const MIGRATION_LOCK_ID = 918_273_645;

export async function runMigrations(pool: Pool): Promise<void> {
  // Everything in this function runs on ONE dedicated connection — not the
  // shared pool — for two reasons:
  //   1. The chicken-and-egg problem already solved on Day 1 (see below):
  //      creating the `vector` extension has to happen before ANY
  //      connection that has pgvector.registerTypes() attached (i.e. every
  //      connection the shared pool opens) can succeed.
  //   2. An advisory lock is a SESSION-level lock — it's only held for as
  //      long as this one connection stays open. Acquiring it via the pool
  //      (which hands out and reclaims different underlying connections
  //      over time) wouldn't reliably hold the lock for this function's
  //      entire duration the way one dedicated client does.
  const client = new pg.Client({ connectionString: pool.options.connectionString });
  await client.connect();

  try {
    // Blocks here until no other process is currently inside this same
    // function against this same database — this is the fix for the
    // concurrent-migration race described above. Whichever caller loses the
    // race simply waits its turn.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

    await client.query('CREATE EXTENSION IF NOT EXISTS vector');

    // The migration-tracking table itself has to be created the same way,
    // before any real migration runs — it's infrastructure FOR the
    // migration system, not a migration itself, so it isn't tracked inside
    // schema_migrations the way 001/002 are.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Filenames are prefixed with a zero-padded number (001_, 002_, ...)
    // specifically so a plain alphabetical sort is also the correct
    // application order — no separate ordering metadata needed.
    const migrationFiles = (await readdir(migrationsDir))
      .filter((filename) => filename.endsWith('.sql'))
      .sort();

    const { rows: appliedRows } = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations',
    );
    const alreadyApplied = new Set(appliedRows.map((row) => row.name));

    for (const filename of migrationFiles) {
      if (alreadyApplied.has(filename)) continue;

      const sql = await readFile(path.join(migrationsDir, filename), 'utf-8');

      // Each migration runs in its own transaction, together with the
      // INSERT that records it as applied — either the migration's SQL AND
      // the tracking record both commit, or neither does. Without this, a
      // crash between "run the migration" and "record that it ran" would
      // leave the migration re-attempted on the next startup, which is
      // actively dangerous for a migration like 002 that TRUNCATEs a table
      // — running it twice on data inserted between the two attempts would
      // silently discard real rows a second time.
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [filename]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }
  } finally {
    // Releasing the advisory lock is technically implicit on disconnect
    // (session-level locks are automatically released when the session
    // ends), but releasing it explicitly before closing the connection
    // makes the intent obvious to a reader rather than relying on that
    // implicit behavior.
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    await client.end();
  }
}
