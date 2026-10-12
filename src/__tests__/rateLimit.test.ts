import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerRateLimit } from '../plugins/rateLimit.js';

async function buildApp(maxPerHour: number) {
  const app = Fastify({ trustProxy: 1 });
  await registerRateLimit(app, { maxPerHour });
  app.post('/paid', async () => ({ ok: true }));
  app.get('/free', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('registerRateLimit', () => {
  it('returns 429 with a readable message once a client exceeds its POSTs for the hour', async () => {
    const app = await buildApp(2);

    expect((await app.inject({ method: 'POST', url: '/paid' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/paid' })).statusCode).toBe(200);
    const limited = await app.inject({ method: 'POST', url: '/paid' });

    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toContain('this demo allows 2 actions per hour');
  });

  it('never limits GET requests', async () => {
    const app = await buildApp(1);

    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: 'GET', url: '/free' })).statusCode).toBe(200);
    }
  });

  it('counts each client separately, keyed on the address nginx appends to X-Forwarded-For', async () => {
    const app = await buildApp(1);
    const from = (ip: string) =>
      app.inject({ method: 'POST', url: '/paid', headers: { 'x-forwarded-for': ip }, remoteAddress: '127.0.0.1' });

    expect((await from('203.0.113.1')).statusCode).toBe(200);
    expect((await from('203.0.113.1')).statusCode).toBe(429);
    expect((await from('203.0.113.2')).statusCode).toBe(200);
    // A client can't dodge the limit by sending its own X-Forwarded-For:
    // nginx appends the real address, and only that last entry is trusted.
    expect((await from('198.51.100.9, 203.0.113.1')).statusCode).toBe(429);
  });
});
