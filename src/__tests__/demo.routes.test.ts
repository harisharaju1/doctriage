import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { demoRoutes } from '../routes/demo.js';

describe('GET /', () => {
  it('serves the demo page as HTML', async () => {
    const app = Fastify();
    await app.register(demoRoutes);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('doctriage');
    // A loose smoke check that the upload/classify/embed/query flow is
    // actually wired into the page, not just that some HTML came back.
    expect(response.body).toContain('/documents');
    expect(response.body).toContain('/classify');
    expect(response.body).toContain('/embed');
    expect(response.body).toContain('/query');
  });
});
