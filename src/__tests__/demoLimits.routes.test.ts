// src/__tests__/demoLimits.routes.test.ts
//
// Week 4: the public demo's spend guards on src/routes/documents.ts — the
// daily budget (paid routes return 503 once today's recorded spend reaches
// it) and the document-length cap at upload. Same in-memory setup as
// documents.routes.test.ts; classifyDocument is mocked so nothing here can
// make a real model call.

import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { documentRoutes, MAX_UPLOAD_SIZE_BYTES } from '../routes/documents.js';
import { InMemoryCostRepository } from '../repositories/inMemoryCostRepository.js';
import { InMemoryDocumentRepository } from '../repositories/inMemoryDocumentRepository.js';
import { InMemoryEmbeddingRepository } from '../repositories/inMemoryEmbeddingRepository.js';
import { InMemoryReviewQueueRepository } from '../repositories/inMemoryReviewQueueRepository.js';
import { MockEmbeddingGenerator } from '../services/mockEmbeddingGenerator.js';

vi.mock('../services/classifier.js', () => ({
  classifyDocument: vi.fn(),
  MODEL: 'claude-haiku-4-5-20251001',
}));

// Same minimal single-page PDF as documents.routes.test.ts: its text is
// "Insurance Claim Form", three words.
const MINIMAL_PDF_WITH_TEXT = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]
   /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 56 >>
stream
BT /F1 12 Tf 100 700 Td (Insurance Claim Form) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000062 00000 n
0000000119 00000 n
0000000274 00000 n
0000000381 00000 n
trailer
<< /Size 6 /Root 1 0 R >>
startxref
459
%%EOF`;

async function buildApp(limits: { dailyBudgetUsd: number; maxDocumentWords: number }) {
  const app = Fastify();
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_SIZE_BYTES } });
  const costRepo = new InMemoryCostRepository();
  await app.register(documentRoutes, {
    repo: new InMemoryDocumentRepository(),
    embeddingRepo: new InMemoryEmbeddingRepository(),
    embeddingGenerator: new MockEmbeddingGenerator(),
    reviewQueueRepo: new InMemoryReviewQueueRepository(),
    costRepo,
    limits,
  });
  await app.ready();
  return { app, costRepo };
}

async function upload(app: FastifyInstance) {
  const form = new FormData();
  form.append('file', new Blob([MINIMAL_PDF_WITH_TEXT], { type: 'application/pdf' }), 'claim.pdf');
  return app.inject({ method: 'POST', url: '/documents', payload: form });
}

describe('demo spend guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses paid routes with 503 once today\'s spend reaches the budget, without calling the model', async () => {
    const { classifyDocument } = await import('../services/classifier.js');
    const { app, costRepo } = await buildApp({ dailyBudgetUsd: 0.01, maxDocumentWords: 5000 });
    const { documentId } = (await upload(app)).json();
    await costRepo.record({
      documentId,
      stage: 'classification',
      modelId: 'claude-haiku-4-5-20251001',
      usage: { inputTokens: 10_000, outputTokens: 0 },
      costUsd: 0.01,
    });

    for (const path of ['classify', 'embed']) {
      const response = await app.inject({ method: 'POST', url: `/documents/${documentId}/${path}` });
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toContain('budget');
    }
    const query = await app.inject({
      method: 'POST',
      url: `/documents/${documentId}/query`,
      payload: { question: 'anything' },
    });
    expect(query.statusCode).toBe(503);
    expect(vi.mocked(classifyDocument)).not.toHaveBeenCalled();
  });

  it('only counts spend recorded since 00:00 UTC today', async () => {
    const { classifyDocument } = await import('../services/classifier.js');
    vi.mocked(classifyDocument).mockResolvedValue({
      status: 'success',
      classification: { documentType: 'claim_form', confidence: 0.95, reasoning: 'Has a claim form title.' },
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    const { app, costRepo } = await buildApp({ dailyBudgetUsd: 0.01, maxDocumentWords: 5000 });
    const { documentId } = (await upload(app)).json();
    const yesterday = await costRepo.record({
      documentId,
      stage: 'classification',
      modelId: 'claude-haiku-4-5-20251001',
      usage: { inputTokens: 10_000, outputTokens: 0 },
      costUsd: 5,
    });
    yesterday.recordedAt.setUTCDate(yesterday.recordedAt.getUTCDate() - 1);

    const response = await app.inject({ method: 'POST', url: `/documents/${documentId}/classify` });

    expect(response.statusCode).toBe(200);
    expect(vi.mocked(classifyDocument)).toHaveBeenCalledOnce();
  });

  it('leaves free routes available when the budget is spent', async () => {
    const { app, costRepo } = await buildApp({ dailyBudgetUsd: 0.01, maxDocumentWords: 5000 });
    const uploaded = await upload(app);
    const { documentId } = uploaded.json();
    await costRepo.record({
      documentId,
      stage: 'embedding',
      modelId: 'amazon.titan-embed-text-v2:0',
      usage: { inputTokens: 1, outputTokens: 0 },
      costUsd: 1,
    });

    expect(uploaded.statusCode).toBe(201);
    expect((await upload(app)).statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: `/documents/${documentId}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
  });

  it('rejects documents longer than the word cap at upload', async () => {
    const { app } = await buildApp({ dailyBudgetUsd: 2, maxDocumentWords: 2 });

    const response = await upload(app);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('This document has 3 words; the demo accepts up to 2.');
  });
});
