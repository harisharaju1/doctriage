import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  // POSTGRES_URL is required as of Week 2 Day 1: src/config/db.ts opens a
  // real connection pool at startup, and src/db/migrate.ts runs a schema
  // migration against it before the server starts listening. Validating it
  // here means a missing/malformed value crashes the process immediately,
  // with a clear message — the same "fail fast at boot" reasoning already
  // applied to ANTHROPIC_API_KEY, instead of surfacing as a confusing error
  // on the first request that happens to touch the database.
  POSTGRES_URL: z.url(),
  // MONGO_URL / REDIS_URL stay optional — no code connects to either yet.
  // Each flips to required the day its own connection code is added.
  MONGO_URL: z.url().optional(),
  REDIS_URL: z.url().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${result.error.message}`);
  }

  return result.data;
}
