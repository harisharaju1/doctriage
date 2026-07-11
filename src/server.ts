import 'dotenv/config';
import net from 'node:net';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { loadEnv } from './config/env.js';
import { pool } from './config/db.js';
import { runMigrations } from './db/migrate.js';
import { InMemoryDocumentRepository } from './repositories/inMemoryDocumentRepository.js';
import { PostgresEmbeddingRepository } from './repositories/postgresEmbeddingRepository.js';
import { documentRoutes, MAX_UPLOAD_SIZE_BYTES } from './routes/documents.js';
import { healthRoutes } from './routes/health.js';

const env = loadEnv();

const app = Fastify({
  logger: {
    level: 'info',
    transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
  },
});

await app.register(multipart, {
  limits: { fileSize: MAX_UPLOAD_SIZE_BYTES },
});

await app.register(healthRoutes);

const documentRepo = new InMemoryDocumentRepository();
// Shares the one pool from src/config/db.ts — same reasoning as that file's
// "why one shared pool" comment: every repository that talks to Postgres
// should draw from the same small set of pooled connections, not open its own.
const embeddingRepo = new PostgresEmbeddingRepository(pool);
await app.register(documentRoutes, { repo: documentRepo, embeddingRepo });

// As of Week 2 Day 1, Postgres is genuinely load-bearing (previously nothing
// used it — see checkConnectivity() below, which used to include it as a
// "just checking, not required yet" ping). Running the schema migration
// BEFORE app.listen(), inside the same try/catch that already guards server
// startup, means a broken/unreachable database crashes the process loudly
// and immediately — the same "fail fast at boot" instinct already applied to
// env validation — rather than the app appearing to start fine and only
// failing later, confusingly, on the first request that happens to touch
// the chunk_embeddings table.
try {
  await runMigrations(pool);
  app.log.info('Postgres migrations applied');

  const address = await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(`Server listening at ${address}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

checkConnectivity();

// Pings each configured DB after startup and logs reachability.
// Does not fail startup — nothing depends on these connections yet.
//
// Postgres is intentionally NOT in this list anymore. It used to be, back
// when Postgres was just as unused as Mongo/Redis still are — but as of
// today, the migration step above already proves Postgres is reachable
// (a raw TCP check here would be redundant, and less informative: it would
// only tell us the port is open, not that the schema/auth actually work,
// which runMigrations() already confirmed with a real query).
function checkConnectivity(): void {
  const services: Array<{ name: string; url: string | undefined }> = [
    { name: 'mongo', url: env.MONGO_URL },
    { name: 'redis', url: env.REDIS_URL },
  ];

  for (const { name, url } of services) {
    if (!url) {
      app.log.info(`${name}: no URL configured, skipping connectivity check`);
      continue;
    }

    const { hostname, port } = new URL(url);
    const portNum = parseInt(port, 10) || defaultPort(hostname);
    const socket = net.createConnection({ host: hostname, port: portNum });
    const timer = setTimeout(() => {
      socket.destroy();
      app.log.warn(`${name}: connectivity check timed out (${hostname}:${portNum})`);
    }, 2000);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      app.log.info(`${name}: reachable at ${hostname}:${portNum}`);
    });

    socket.once('error', (err) => {
      clearTimeout(timer);
      app.log.warn(`${name}: not reachable at ${hostname}:${portNum} — ${err.message}`);
    });
  }
}

function defaultPort(hostname: string): number {
  if (hostname === 'mongo') return 27017;
  if (hostname === 'redis') return 6379;
  return 80;
}
