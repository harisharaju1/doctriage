// src/db/migrate.ts
//
// A deliberately tiny "migration runner" — there's no migration framework in
// this project (no Flyway, no node-pg-migrate, no EF-Core-style migration
// history table with Up()/Down() methods). For a single migration (turn on
// the vector extension, create one table), that's not a gap worth filling
// yet — this file just reads schema.sql and executes it.
//
// WHY NOT DOCKER'S docker-entrypoint-initdb.d/ MECHANISM?
// Postgres's official image auto-runs any .sql file dropped into
// /docker-entrypoint-initdb.d/ — but only the very first time a container
// starts against a brand-new, *empty* data volume. Our `pgdata` volume has
// existed since Week 1 Day 6 (docker-compose.yml), so a script placed there
// today would silently never run against it. Running the migration from the
// app itself, every time it starts, sidesteps that entirely: it works
// identically whether the volume is fresh or not, locally or on the VPS.
//
// WHY IS schema.sql SAFE TO RUN REPEATEDLY?
// Every statement in schema.sql uses "IF NOT EXISTS" — so running this
// function on every single app startup (which we do, in server.ts) is a
// no-op once the schema already exists, and does the right thing the first
// time it doesn't. No separate "has this migration already run?" bookkeeping
// needed for a single migration.
//
// .NET parallel: this is closer to a minimal IHostedService that runs raw DDL
// on startup than to `dotnet ef database update` — EF Core Migrations'
// versioned history table and generated Up()/Down() methods are the
// "grown-up" version of what this two-statement idempotent script does here.
// Worth adopting a real tool once there's a second migration to manage.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg, { type Pool } from 'pg';

// Resolve schema.sql relative to *this file's own location* rather than
// process.cwd() — that way it works the same whether this runs from
// src/db/migrate.ts (via `tsx` in development) or from the compiled
// dist/db/migrate.js (in production), since the build script copies
// schema.sql alongside the compiled output (see package.json's "build" script).
const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export async function runMigrations(pool: Pool): Promise<void> {
  // CHICKEN-AND-EGG PROBLEM: src/config/db.ts configures the shared pool to
  // run pgvector.registerTypes(client) on every new connection it opens —
  // and registerTypes() itself queries Postgres for the `vector` type's
  // internal ID, throwing "vector type not found in the database" if the
  // pgvector extension hasn't been enabled yet. On a brand-new database,
  // that's exactly the situation: the extension doesn't exist until
  // schema.sql's `CREATE EXTENSION IF NOT EXISTS vector` runs — but that
  // statement would need to go through the very pool whose first connection
  // attempt just failed for that exact reason.
  //
  // The fix: create the extension first, using a throwaway `pg.Client` that
  // does NOT have the registerTypes hook attached, so creating the extension
  // doesn't depend on the extension already existing. Once this succeeds,
  // the shared pool's onConnect hook is guaranteed to find the `vector` type
  // and stops being a problem for every connection after this point.
  const bootstrapClient = new pg.Client({ connectionString: pool.options.connectionString });
  await bootstrapClient.connect();
  try {
    await bootstrapClient.query('CREATE EXTENSION IF NOT EXISTS vector');
  } finally {
    await bootstrapClient.end();
  }

  // Now that the extension is guaranteed to exist, it's safe to run the full
  // schema (including its own, now-redundant-but-harmless CREATE EXTENSION
  // line) through the shared pool — its first real connection will succeed
  // at registering pgvector's types.
  //
  // A single pool.query() call can run multiple semicolon-separated
  // statements at once (node-postgres passes the whole string through to
  // Postgres's simple query protocol), so we don't need to split schema.sql
  // into individual statements ourselves.
  const schemaSql = await readFile(schemaPath, 'utf-8');
  await pool.query(schemaSql);
}
