import { describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';

// Shared by every test that needs a fully valid environment — spelled out
// once here rather than repeated in each test, so adding a new required env
// var (as AWS_ACCESS_KEY_ID etc. were on Week 2 Day 3) only means updating
// this one object instead of every test in the file.
const validEnv = {
  ANTHROPIC_API_KEY: 'sk-ant-test',
  POSTGRES_URL: 'postgresql://doctriage:doctriage@localhost:5432/doctriage',
  AWS_ACCESS_KEY_ID: 'test-access-key-id',
  AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
  AWS_REGION: 'ap-south-1',
};

// Returns a copy of validEnv with one key removed — used by every "throws
// when X is missing" test below. A plain destructure-and-discard
// (`const { X: _, ...rest } = validEnv`) trips this project's eslint
// no-unused-vars rule on the discarded binding, so this small helper avoids
// that noise instead of suppressing the rule.
function omit(key: keyof typeof validEnv): Record<string, string> {
  const copy: Record<string, string> = { ...validEnv };
  delete copy[key];
  return copy;
}

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    const env = loadEnv({ ...validEnv, NODE_ENV: 'test', PORT: '4000' });

    expect(env.NODE_ENV).toBe('test');
    expect(env.PORT).toBe(4000);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test');
    expect(env.POSTGRES_URL).toBe('postgresql://doctriage:doctriage@localhost:5432/doctriage');
    expect(env.AWS_ACCESS_KEY_ID).toBe('test-access-key-id');
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('test-secret-access-key');
    expect(env.AWS_REGION).toBe('ap-south-1');
  });

  it('applies defaults for NODE_ENV, PORT, and AWS_BEDROCK_EMBEDDING_MODEL_ID when not set', () => {
    const env = loadEnv(validEnv);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    // Defaults to the current Titan Text Embeddings model — see
    // docs/week-2-day-3.md for why this is v2, not the v1 the original plan
    // assumed (v1 no longer appears in Bedrock's model catalog at all).
    expect(env.AWS_BEDROCK_EMBEDDING_MODEL_ID).toBe('amazon.titan-embed-text-v2:0');
  });

  it('throws when ANTHROPIC_API_KEY is missing', () => {
    expect(() => loadEnv(omit('ANTHROPIC_API_KEY'))).toThrow(/Invalid environment configuration/);
  });

  // New as of Week 2 Day 1 — POSTGRES_URL just became required (see config/env.ts).
  // This test locks in that "fail fast at boot" behavior: a real Postgres
  // connection is opened at startup now, so a missing URL must be caught
  // here, not several files later when the connection pool tries to connect.
  it('throws when POSTGRES_URL is missing', () => {
    expect(() => loadEnv(omit('POSTGRES_URL'))).toThrow(/Invalid environment configuration/);
  });

  // New as of Week 2 Day 3 — AWS credentials became required the moment
  // BedrockEmbeddingGenerator became the production embedding path. Same
  // fail-fast reasoning: catch a missing credential at boot, not on the
  // first request that happens to call Bedrock.
  it('throws when AWS_ACCESS_KEY_ID is missing', () => {
    expect(() => loadEnv(omit('AWS_ACCESS_KEY_ID'))).toThrow(/Invalid environment configuration/);
  });

  it('throws when AWS_SECRET_ACCESS_KEY is missing', () => {
    expect(() => loadEnv(omit('AWS_SECRET_ACCESS_KEY'))).toThrow(/Invalid environment configuration/);
  });

  it('throws when AWS_REGION is missing', () => {
    expect(() => loadEnv(omit('AWS_REGION'))).toThrow(/Invalid environment configuration/);
  });
});
