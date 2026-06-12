import 'dotenv/config';
import Fastify from 'fastify';
import { loadEnv } from './config/env.js';
import { healthRoutes } from './routes/health.js';

const env = loadEnv();

const app = Fastify({
  logger: {
    level: 'info',
    transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
  },
});

await app.register(healthRoutes);

try {
  const address = await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(`Server listening at ${address}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
