import 'dotenv/config';
import net from 'node:net';
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

checkConnectivity();

// Pings each configured DB after startup and logs reachability.
// Does not fail startup — nothing depends on these connections yet (Week 2).
function checkConnectivity(): void {
  const services: Array<{ name: string; url: string | undefined }> = [
    { name: 'postgres', url: env.POSTGRES_URL },
    { name: 'mongo',    url: env.MONGO_URL },
    { name: 'redis',    url: env.REDIS_URL },
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
  if (hostname === 'postgres') return 5432;
  if (hostname === 'mongo')    return 27017;
  if (hostname === 'redis')    return 6379;
  return 80;
}
