// src/routes/demo.ts
//
// Week 4 Day 3: the showcase page at "/" — vanilla HTML/CSS/JS, no build
// step, no framework (see docs/week-4-plan.md's Day 3). A visitor picks a
// sample (or uploads a PDF) and watches it move through the actual
// pipeline, with each step explained in plain language for non-technical
// readers.
//
// The page started as an inline template string here. It outgrew that once
// it gained the explanatory sections and the narrated demo — a ~900-line
// template literal means escaping every `${` in the page's own JS — so it
// now lives in src/demo/index.html, and the build step copies src/demo into
// dist/demo next to the migrations it already copies. Still no
// @fastify/static: two routes with readFile cover one page and a fixed set
// of sample PDFs, and an explicit allowlist means there's no path-traversal
// surface to reason about.

import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

// Resolves to src/demo under tsx/vitest and dist/demo in the built image.
const DEMO_DIR = new URL('../demo/', import.meta.url);

// The only files GET /samples/:name will serve. All fictional; see the
// sample cards in src/demo/index.html for what each one demonstrates.
export const SAMPLE_FILES = [
  'claim-form.pdf',
  'police-report.pdf',
  'repair-estimate.pdf',
  'discharge-summary.pdf',
  'loose-bill-page.pdf',
  'thank-you-note.pdf',
] as const;

export async function demoRoutes(app: FastifyInstance): Promise<void> {
  // Read once at registration: a missing page should fail at boot, not on
  // the first visitor's request.
  const html = await readFile(new URL('index.html', DEMO_DIR), 'utf8');

  app.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(html);
  });

  app.get<{ Params: { name: string } }>('/samples/:name', async (request, reply) => {
    const { name } = request.params;
    if (!(SAMPLE_FILES as readonly string[]).includes(name)) {
      return reply.status(404).send({ error: `No sample named ${name}` });
    }
    const pdf = await readFile(new URL(`samples/${name}`, DEMO_DIR));
    return reply
      .type('application/pdf')
      .header('Content-Disposition', `inline; filename="${name}"`)
      .header('Cache-Control', 'public, max-age=86400')
      .send(pdf);
  });
}
