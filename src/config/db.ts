// src/config/db.ts
//
// This file owns exactly one thing: the Postgres connection pool.
//
// WHY A POOL, NOT A SINGLE CONNECTION?
// Opening a brand-new TCP connection to Postgres for every query is slow —
// each connection pays a real setup cost (TCP handshake, TLS if enabled,
// Postgres auth). A "pool" solves this by opening a small number of
// connections up front (here, up to 10) and handing them out to whichever
// query needs one; when a query finishes, its connection goes back into the
// pool instead of closing, ready for the next query to reuse.
//
// .NET parallel: this is exactly what ADO.NET/Npgsql's connection pooling
// does automatically behind the scenes. Here we're configuring it explicitly
// with node-postgres's `pg.Pool`, so the mechanics are visible instead of
// hidden inside framework defaults.
//
// WHY ONE SHARED POOL, EXPORTED AS A SINGLETON?
// If every repository or service created its own `new Pool(...)`, we'd end
// up with several independent pools all competing for the small number of
// connections Postgres allows — easy to accidentally exhaust. Creating the
// pool once, here, and importing it everywhere else keeps connection usage
// centralized and easy to reason about (same instinct as registering one
// DbContext/connection factory in a DI container rather than `new`-ing
// connections ad hoc throughout a .NET codebase).

import pg from 'pg';
import pgvector from 'pgvector/pg';
import { loadEnv } from './env.js';

const env = loadEnv();

export const pool = new pg.Pool({
  connectionString: env.POSTGRES_URL,

  // Maximum number of simultaneous connections this pool will open. 10 is a
  // generous ceiling for a single-instance dev/learning project — in a real
  // production deployment this would be tuned against Postgres's own
  // max_connections setting and how many app instances share the database.
  max: 10,

  // How long (ms) an unused connection sits idle in the pool before
  // node-postgres closes it and shrinks the pool back down. Keeps the pool
  // from permanently holding open connections it isn't using.
  idleTimeoutMillis: 30_000,

  // pgvector needs to register a type parser/serializer *on every individual
  // connection* the pool opens (not once globally) — `onConnect` is
  // node-postgres's hook for "run this setup on each new connection before
  // it's handed out." Without this, inserting/reading a `vector` column would
  // require manually calling `pgvector.toSql()`/`pgvector.fromSql()` by hand
  // on every query; registering the type once here means a plain JS
  // `number[]` just works as the value for a `vector` column, in both
  // directions.
  async onConnect(client) {
    await pgvector.registerTypes(client);
  },
});

// A pool-level 'error' event fires when a connection that's sitting idle in
// the pool (not currently running a query) unexpectedly dies — e.g. Postgres
// restarts, or the network blips. Without a listener here, that error would
// be an unhandled 'error' event on the pool's EventEmitter, which crashes the
// entire Node process. Logging it instead lets the pool quietly replace the
// dead connection and keeps the app running.
pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
});
