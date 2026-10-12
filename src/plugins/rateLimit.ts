// src/plugins/rateLimit.ts
//
// Week 4: per-client rate limit for the public demo. Only POST requests
// count — every route that uploads a file or spends money on a model call
// is a POST, while the page itself, the sample PDFs, /health, /metrics and
// the GET lookups stay free to load.
//
// The client is identified by request.ip. Behind nginx that is only the
// real visitor's address if (1) the app port isn't reachable directly
// (docker-compose.yml binds it to 127.0.0.1) and (2) nginx appends the
// client address with `proxy_set_header X-Forwarded-For
// $proxy_add_x_forwarded_for;` — server.ts sets trustProxy to one hop, so
// Fastify reads the last X-Forwarded-For entry, the one nginx wrote.
//
// In-memory store: fine for one process on one VPS. A second instance
// would need the Redis store this plugin also supports.

import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

export interface RateLimitOptions {
  maxPerHour: number;
}

export async function registerRateLimit(app: FastifyInstance, { maxPerHour }: RateLimitOptions): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: maxPerHour,
    timeWindow: '1 hour',
    allowList: (request) => request.method !== 'POST',
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: `Too many requests from your network: this demo allows ${context.max} actions per hour. Please try again in ${context.after}.`,
    }),
  });
}
