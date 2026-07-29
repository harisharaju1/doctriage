import 'dotenv/config';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { loadEnv } from './config/env.js';
import { pool } from './config/db.js';
import { runMigrations } from './db/migrate.js';
import { InMemoryCostRepository } from './repositories/inMemoryCostRepository.js';
import { InMemoryDocumentRepository } from './repositories/inMemoryDocumentRepository.js';
import { InMemoryReviewQueueRepository } from './repositories/inMemoryReviewQueueRepository.js';
import { PostgresEmbeddingRepository } from './repositories/postgresEmbeddingRepository.js';
import { demoRoutes } from './routes/demo.js';
import { documentRoutes, MAX_UPLOAD_SIZE_BYTES } from './routes/documents.js';
import { healthRoutes } from './routes/health.js';
import { BedrockEmbeddingGenerator } from './services/bedrockEmbeddingGenerator.js';

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
// Week 4 Day 3: the live pipeline showcase page — served at "/", so the
// domain's root URL itself is the demo, not a 404 or a bare API response.
await app.register(demoRoutes);

const documentRepo = new InMemoryDocumentRepository();
// Shares the one pool from src/config/db.ts — same reasoning as that file's
// "why one shared pool" comment: every repository that talks to Postgres
// should draw from the same small set of pooled connections, not open its own.
const embeddingRepo = new PostgresEmbeddingRepository(pool);
// The REAL embedding path — as of Week 2 Day 3, production calls Bedrock's
// Titan Text Embeddings V2, not the deterministic mock every test still
// uses (MockEmbeddingGenerator). This is the one place in the whole app
// that decides "which EmbeddingGenerator implementation is actually in
// play" — everything downstream (routes, retrieval.ts) only ever sees the
// EmbeddingGenerator interface, never this concrete class.
const embeddingGenerator = new BedrockEmbeddingGenerator();
// Week 3 Day 2: in-memory, same reasoning as documentRepo above — nothing
// about review-queue entries needs Postgres durability yet.
const reviewQueueRepo = new InMemoryReviewQueueRepository();
// Week 3 Day 3: in-memory, same reasoning as reviewQueueRepo above.
const costRepo = new InMemoryCostRepository();
await app.register(documentRoutes, {
  repo: documentRepo,
  embeddingRepo,
  embeddingGenerator,
  reviewQueueRepo,
  costRepo,
});

// Postgres is genuinely load-bearing (Week 2 Day 1). Running the schema
// migration BEFORE app.listen(), inside the same try/catch that already
// guards server startup, means a broken/unreachable database crashes the
// process loudly and immediately — the same "fail fast at boot" instinct
// already applied to env validation — rather than the app appearing to
// start fine and only failing later, confusingly, on the first request
// that happens to touch the chunk_embeddings table.
try {
  await runMigrations(pool);
  app.log.info('Postgres migrations applied');

  const address = await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(`Server listening at ${address}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
