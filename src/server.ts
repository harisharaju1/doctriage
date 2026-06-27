import 'dotenv/config';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { loadEnv } from './config/env.js';
import { InMemoryDocumentRepository } from './repositories/inMemoryDocumentRepository.js';
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
await app.register(documentRoutes, { repo: documentRepo });

try {
  const address = await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(`Server listening at ${address}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
