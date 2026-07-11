import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Loads .env into process.env before any test file runs. Needed as of
    // Week 2 Day 1: embeddingRepository.integration.test.ts checks
    // process.env.POSTGRES_URL to decide whether to skip itself, and (when
    // it doesn't skip) config/db.ts reads process.env.POSTGRES_URL for real.
    // Without this, running `pnpm test` outside of `pnpm dev` (which loads
    // .env itself via server.ts's `import 'dotenv/config'`) would never see
    // POSTGRES_URL, and the integration test would always silently skip.
    setupFiles: ['dotenv/config'],
  },
});
