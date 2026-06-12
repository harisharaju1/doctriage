import { describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      PORT: '4000',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });

    expect(env.NODE_ENV).toBe('test');
    expect(env.PORT).toBe(4000);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test');
  });

  it('applies defaults for NODE_ENV and PORT when not set', () => {
    const env = loadEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
  });

  it('throws when ANTHROPIC_API_KEY is missing', () => {
    expect(() => loadEnv({ NODE_ENV: 'test', PORT: '4000' })).toThrow(
      /Invalid environment configuration/,
    );
  });
});
