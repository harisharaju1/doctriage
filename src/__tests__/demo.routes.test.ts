import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { demoRoutes, SAMPLE_FILES } from '../routes/demo.js';

async function buildApp() {
  const app = Fastify();
  await app.register(demoRoutes);
  await app.ready();
  return app;
}

describe('GET /', () => {
  it('serves the demo page as HTML', async () => {
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('doctriage');
    // A loose smoke check that the upload/classify/review/embed/query flow
    // is actually wired into the page, not just that some HTML came back.
    expect(response.body).toContain('/documents');
    expect(response.body).toContain('/classify');
    expect(response.body).toContain('/review-queue/');
    expect(response.body).toContain('/embed');
    expect(response.body).toContain('/query');
  });

  it('offers every sample the server can serve, and no others', async () => {
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/' });
    const referenced = [...response.body.matchAll(/file: '([^']+\.pdf)'/g)].map((m) => m[1]);

    expect(referenced.sort()).toEqual([...SAMPLE_FILES].sort());
  });
});

describe('GET /samples/:name', () => {
  it.each(SAMPLE_FILES)('serves %s as a PDF', async (name) => {
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: `/samples/${name}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('returns 404 for anything outside the allowlist', async () => {
    const app = await buildApp();

    for (const url of ['/samples/nope.pdf', '/samples/..%2F..%2F.env', '/samples/index.html']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
    }
  });
});
