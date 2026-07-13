// src/__tests__/documents.routes.test.ts
//
// Route-level tests exercising the full HTTP contract of src/routes/documents.ts
// — upload, classify, embed, query, and the new batch endpoints — WITHOUT any
// real Postgres or Anthropic API dependency. This is possible specifically
// because:
//   1. EmbeddingRepository is an interface — InMemoryEmbeddingRepository
//      (a real implementation, not a test-only mock) stands in for
//      PostgresEmbeddingRepository with identical behavior.
//   2. classifyDocument is mocked at the module level, since it's a direct
//      Anthropic SDK call with no interface behind it yet (see the earlier
//      discussion of that in docs/ — classifier.ts isn't behind an
//      abstraction the way the repositories are).
//
// Uploads are built with the platform's global FormData/Blob and sent via
// Fastify's inject() — light-my-request (which powers inject()) accepts a
// FormData payload directly and handles the multipart boundary/headers
// itself, the same way a real HTTP client would.

import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { documentRoutes, MAX_UPLOAD_SIZE_BYTES } from '../routes/documents.js';
import { InMemoryDocumentRepository } from '../repositories/inMemoryDocumentRepository.js';
import { InMemoryEmbeddingRepository } from '../repositories/inMemoryEmbeddingRepository.js';
import { MockEmbeddingGenerator } from '../services/mockEmbeddingGenerator.js';
import type { EmbeddingGenerator } from '../services/embeddingGenerator.js';

vi.mock('../services/classifier.js', () => ({
  classifyDocument: vi.fn(),
}));

// Reused from extraction.test.ts's fixture pattern — a minimal, valid,
// single-page PDF with a real text stream, small enough to inline here
// rather than depend on an external fixture file.
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

function buildApp(): FastifyInstance {
  const app = Fastify();
  return app;
}

async function registerRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_SIZE_BYTES } });
  const repo = new InMemoryDocumentRepository();
  const embeddingRepo = new InMemoryEmbeddingRepository();
  // MockEmbeddingGenerator, not BedrockEmbeddingGenerator — route tests
  // should never need real AWS credentials to pass. See that class's header
  // comment, and src/services/embeddingGenerator.ts's, for why this
  // interface exists at all.
  const embeddingGenerator = new MockEmbeddingGenerator();
  await app.register(documentRoutes, { repo, embeddingRepo, embeddingGenerator });
  await app.ready();
  return app;
}

function pdfForm(filename = 'claim.pdf'): FormData {
  const form = new FormData();
  form.append('file', new Blob([MINIMAL_PDF_WITH_TEXT], { type: 'application/pdf' }), filename);
  return form;
}

describe('document routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = buildApp();
    await registerRoutes(app);
  });

  it('POST /documents uploads a single file and returns 201', async () => {
    const response = await app.inject({ method: 'POST', url: '/documents', payload: pdfForm() });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe('uploaded');
    expect(body.extraction.status).toBe('success');
  });

  it('POST /documents rejects a non-PDF file with 400', async () => {
    const form = new FormData();
    form.append('file', new Blob(['not a pdf'], { type: 'text/plain' }), 'notes.txt');

    const response = await app.inject({ method: 'POST', url: '/documents', payload: form });

    expect(response.statusCode).toBe(400);
  });

  it('classification is persisted and shows up on a later GET', async () => {
    const { classifyDocument } = await import('../services/classifier.js');
    vi.mocked(classifyDocument).mockResolvedValue({
      status: 'success',
      classification: { documentType: 'claim_form', confidence: 0.9, reasoning: 'looks like a claim form' },
    });

    const uploadResponse = await app.inject({ method: 'POST', url: '/documents', payload: pdfForm() });
    const { documentId } = uploadResponse.json();

    // Before classifying: GET should show no classification yet.
    const beforeGet = await app.inject({ method: 'GET', url: `/documents/${documentId}` });
    expect(beforeGet.json().classification).toBeUndefined();

    const classifyResponse = await app.inject({
      method: 'POST',
      url: `/documents/${documentId}/classify`,
    });
    expect(classifyResponse.statusCode).toBe(200);

    // After classifying: GET should now surface the persisted classification
    // — this is the actual behavior that was missing before today's change.
    const afterGet = await app.inject({ method: 'GET', url: `/documents/${documentId}` });
    expect(afterGet.json().classification).toEqual({
      documentType: 'claim_form',
      confidence: 0.9,
      reasoning: 'looks like a claim form',
    });
  });

  it('GET /documents/:id reports chunksStored, 0 before /embed and N after', async () => {
    const uploadResponse = await app.inject({ method: 'POST', url: '/documents', payload: pdfForm() });
    const { documentId } = uploadResponse.json();

    const beforeEmbed = await app.inject({ method: 'GET', url: `/documents/${documentId}` });
    expect(beforeEmbed.json().chunksStored).toBe(0);

    const embedResponse = await app.inject({ method: 'POST', url: `/documents/${documentId}/embed` });
    expect(embedResponse.statusCode).toBe(200);
    const { chunksStored } = embedResponse.json();
    expect(chunksStored).toBeGreaterThan(0);

    const afterEmbed = await app.inject({ method: 'GET', url: `/documents/${documentId}` });
    expect(afterEmbed.json().chunksStored).toBe(chunksStored);
  });

  it('POST /documents/batch returns details for found IDs and lists the rest as notFound', async () => {
    const { classifyDocument } = await import('../services/classifier.js');
    vi.mocked(classifyDocument).mockResolvedValue({
      status: 'success',
      classification: { documentType: 'claim_form', confidence: 0.8, reasoning: 'reasoning' },
    });

    const upload1 = (await app.inject({ method: 'POST', url: '/documents', payload: pdfForm('a.pdf') })).json();
    const upload2 = (await app.inject({ method: 'POST', url: '/documents', payload: pdfForm('b.pdf') })).json();

    // Document 1 gets fully processed (classified + embedded); document 2 is
    // left untouched — the batch response should reflect that difference
    // per-document, not report the same shape for both.
    await app.inject({ method: 'POST', url: `/documents/${upload1.documentId}/classify` });
    await app.inject({ method: 'POST', url: `/documents/${upload1.documentId}/embed` });

    const missingId = '00000000-0000-0000-0000-000000000000';

    const batchResponse = await app.inject({
      method: 'POST',
      url: '/documents/batch',
      payload: { documentIds: [upload1.documentId, upload2.documentId, missingId] },
    });

    expect(batchResponse.statusCode).toBe(200);
    const body = batchResponse.json();

    expect(body.notFound).toEqual([missingId]);
    expect(body.documents).toHaveLength(2);

    const doc1 = body.documents.find((d: { documentId: string }) => d.documentId === upload1.documentId);
    const doc2 = body.documents.find((d: { documentId: string }) => d.documentId === upload2.documentId);

    expect(doc1.classification.documentType).toBe('claim_form');
    expect(doc1.chunksStored).toBeGreaterThan(0);
    expect(doc2.classification).toBeUndefined();
    expect(doc2.chunksStored).toBe(0);
  });

  it('POST /documents/batch rejects an empty documentIds array with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/documents/batch',
      payload: { documentIds: [] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('POST /documents/batch-upload processes multiple files and reports per-file outcomes', async () => {
    const form = new FormData();
    form.append('file', new Blob([MINIMAL_PDF_WITH_TEXT], { type: 'application/pdf' }), 'good.pdf');
    form.append('file', new Blob(['not a pdf'], { type: 'text/plain' }), 'bad.txt');

    const response = await app.inject({ method: 'POST', url: '/documents/batch-upload', payload: form });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.documents).toHaveLength(2);

    const good = body.documents.find((d: { filename: string }) => d.filename === 'good.pdf');
    const bad = body.documents.find((d: { filename: string }) => d.filename === 'bad.txt');

    expect(good.status).toBe('uploaded');
    expect(good.documentId).toBeTruthy();
    expect(bad.status).toBe('rejected');
    expect(bad.error).toContain('Unsupported file type');
  });

  // Locks in a real gap found while manually testing Day 3's Bedrock
  // integration: BedrockEmbeddingGenerator has already exhausted its own
  // retries by the time an error reaches the route, so anything that throws
  // past that point is a genuine final failure (bad credentials, a
  // persistently unreachable Bedrock endpoint) — and without an explicit
  // catch in the /embed route, that error fell through to Fastify's default
  // handler as a bare 500 "Internal Server Error" instead of the typed,
  // designed failure response every other external-API call in this
  // project returns (compare /classify's 502 for a failed Claude call).
  // This test uses its own app instance with a deliberately-throwing
  // EmbeddingGenerator, rather than the shared MockEmbeddingGenerator every
  // other test in this file uses, specifically to exercise that failure path.
  it('POST /documents/:id/embed returns a typed 502 when the embedding generator fails', async () => {
    const throwingGenerator: EmbeddingGenerator = {
      async generate() {
        throw new Error('Bedrock: The security token included in the request is invalid.');
      },
    };

    const failingApp = Fastify();
    await failingApp.register(multipart, { limits: { fileSize: MAX_UPLOAD_SIZE_BYTES } });
    await failingApp.register(documentRoutes, {
      repo: new InMemoryDocumentRepository(),
      embeddingRepo: new InMemoryEmbeddingRepository(),
      embeddingGenerator: throwingGenerator,
    });
    await failingApp.ready();

    const uploadResponse = await failingApp.inject({ method: 'POST', url: '/documents', payload: pdfForm() });
    const { documentId } = uploadResponse.json();

    const embedResponse = await failingApp.inject({
      method: 'POST',
      url: `/documents/${documentId}/embed`,
    });

    expect(embedResponse.statusCode).toBe(502);
    expect(embedResponse.json().error).toBe('Embedding failed');
    expect(embedResponse.json().reason).toContain('security token');
  });
});
