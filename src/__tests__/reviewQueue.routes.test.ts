// src/__tests__/reviewQueue.routes.test.ts
//
// Week 3 Day 2: covers the human-review-queue branch of
// POST /documents/:id/classify plus the two new review-queue routes.
// Same setup pattern as documents.routes.test.ts — classifyDocument mocked
// at the module level, everything else a real in-memory implementation.
//
// CLASSIFICATION_CONFIDENCE_THRESHOLD defaults to 0.7 (src/config/env.ts).
// Tests below deliberately mock confidence scores on either side of that
// default rather than overriding it via env, so they exercise the same
// threshold production actually uses.

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

// Week 3 Day 3: see documents.routes.test.ts's identical constant.
const MOCK_USAGE = { inputTokens: 100, outputTokens: 20 };

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

function pdfForm(filename = 'claim.pdf'): FormData {
  const form = new FormData();
  form.append('file', new Blob([MINIMAL_PDF_WITH_TEXT], { type: 'application/pdf' }), filename);
  return form;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_SIZE_BYTES } });
  await app.register(documentRoutes, {
    repo: new InMemoryDocumentRepository(),
    embeddingRepo: new InMemoryEmbeddingRepository(),
    embeddingGenerator: new MockEmbeddingGenerator(),
    reviewQueueRepo: new InMemoryReviewQueueRepository(),
    costRepo: new InMemoryCostRepository(),
  });
  await app.ready();
  return app;
}

describe('human review queue', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('a below-threshold classification is queued, not persisted, and returns a pending_review shape', async () => {
    const { classifyDocument } = await import('../services/classifier.js');
    vi.mocked(classifyDocument).mockResolvedValue({
      status: 'success',
      classification: { documentType: 'other', confidence: 0.4, reasoning: 'genuinely ambiguous content' },
      usage: MOCK_USAGE,
    });

    const uploadResponse = await app.inject({ method: 'POST', url: '/documents', payload: pdfForm() });
    const { documentId } = uploadResponse.json();

    const classifyResponse = await app.inject({ method: 'POST', url: `/documents/${documentId}/classify` });
    expect(classifyResponse.statusCode).toBe(200);
    const body = classifyResponse.json();
    expect(body.status).toBe('pending_review');
    expect(body.classification.documentType).toBe('other');
    expect(body.reason).toContain('0.4');

    // Not persisted as trusted — GET should show no classification yet.
    const getResponse = await app.inject({ method: 'GET', url: `/documents/${documentId}` });
    expect(getResponse.json().classification).toBeUndefined();

    // And it shows up in the queue.
    const queueResponse = await app.inject({ method: 'GET', url: '/review-queue' });
    expect(queueResponse.statusCode).toBe(200);
    const queueBody = queueResponse.json();
    expect(queueBody.items).toHaveLength(1);
    expect(queueBody.items[0].documentId).toBe(documentId);
    expect(queueBody.items[0].classification.documentType).toBe('other');
  });

  it('an at/above-threshold classification bypasses the queue entirely', async () => {
    const { classifyDocument } = await import('../services/classifier.js');
    vi.mocked(classifyDocument).mockResolvedValue({
      status: 'success',
      classification: { documentType: 'claim_form', confidence: 0.7, reasoning: 'clear match' },
      usage: MOCK_USAGE,
    });

    const uploadResponse = await app.inject({ method: 'POST', url: '/documents', payload: pdfForm() });
    const { documentId } = uploadResponse.json();

    const classifyResponse = await app.inject({ method: 'POST', url: `/documents/${documentId}/classify` });
    expect(classifyResponse.statusCode).toBe(200);
    expect(classifyResponse.json().status).toBeUndefined();
    expect(classifyResponse.json().documentType).toBe('claim_form');

    const queueResponse = await app.inject({ method: 'GET', url: '/review-queue' });
    expect(queueResponse.json().items).toHaveLength(0);
  });

  it('resolving a queued document persists a human-confirmed classification and dequeues it', async () => {
    const { classifyDocument } = await import('../services/classifier.js');
    vi.mocked(classifyDocument).mockResolvedValue({
      status: 'success',
      classification: { documentType: 'other', confidence: 0.3, reasoning: 'unclear' },
      usage: MOCK_USAGE,
    });

    const uploadResponse = await app.inject({ method: 'POST', url: '/documents', payload: pdfForm() });
    const { documentId } = uploadResponse.json();
    await app.inject({ method: 'POST', url: `/documents/${documentId}/classify` });

    const resolveResponse = await app.inject({
      method: 'POST',
      url: `/review-queue/${documentId}/resolve`,
      payload: { documentType: 'medical_report' },
    });

    expect(resolveResponse.statusCode).toBe(200);
    expect(resolveResponse.json()).toEqual({
      documentType: 'medical_report',
      confidence: 1,
      reasoning: 'Manually resolved via human review queue.',
    });

    const getResponse = await app.inject({ method: 'GET', url: `/documents/${documentId}` });
    expect(getResponse.json().classification).toEqual({
      documentType: 'medical_report',
      confidence: 1,
      reasoning: 'Manually resolved via human review queue.',
    });

    const queueResponse = await app.inject({ method: 'GET', url: '/review-queue' });
    expect(queueResponse.json().items).toHaveLength(0);
  });

  it('resolving an unknown or already-resolved documentId returns 404', async () => {
    const missingId = '00000000-0000-0000-0000-000000000000';

    const response = await app.inject({
      method: 'POST',
      url: `/review-queue/${missingId}/resolve`,
      payload: { documentType: 'claim_form' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('resolving with an invalid documentType returns 400', async () => {
    const { classifyDocument } = await import('../services/classifier.js');
    vi.mocked(classifyDocument).mockResolvedValue({
      status: 'success',
      classification: { documentType: 'other', confidence: 0.3, reasoning: 'unclear' },
      usage: MOCK_USAGE,
    });

    const uploadResponse = await app.inject({ method: 'POST', url: '/documents', payload: pdfForm() });
    const { documentId } = uploadResponse.json();
    await app.inject({ method: 'POST', url: `/documents/${documentId}/classify` });

    const response = await app.inject({
      method: 'POST',
      url: `/review-queue/${documentId}/resolve`,
      payload: { documentType: 'not_a_real_type' },
    });

    expect(response.statusCode).toBe(400);
  });
});
