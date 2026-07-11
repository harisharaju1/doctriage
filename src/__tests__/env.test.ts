import { describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      PORT: '4000',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      POSTGRES_URL: 'postgresql://doctriage:doctriage@localhost:5432/doctriage',
    });

    expect(env.NODE_ENV).toBe('test');
    expect(env.PORT).toBe(4000);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test');
    expect(env.POSTGRES_URL).toBe('postgresql://doctriage:doctriage@localhost:5432/doctriage');
  });

  it('applies defaults for NODE_ENV and PORT when not set', () => {
    const env = loadEnv({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      POSTGRES_URL: 'postgresql://doctriage:doctriage@localhost:5432/doctriage',
    });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
  });

  it('throws when ANTHROPIC_API_KEY is missing', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'test',
        PORT: '4000',
        POSTGRES_URL: 'postgresql://doctriage:doctriage@localhost:5432/doctriage',
      }),
    ).toThrow(/Invalid environment configuration/);
  });

  // New as of Week 2 Day 1 — POSTGRES_URL just became required (see config/env.ts).
  // This test locks in that "fail fast at boot" behavior: a real Postgres
  // connection is opened at startup now, so a missing URL must be caught
  // here, not several files later when the connection pool tries to connect.
  it('throws when POSTGRES_URL is missing', () => {
    expect(() =>
      loadEnv({ NODE_ENV: 'test', PORT: '4000', ANTHROPIC_API_KEY: 'sk-ant-test' }),
    ).toThrow(/Invalid environment configuration/);
  });
});
