// src/__tests__/metrics.routes.test.ts
//
// Week 3 Day 3: exercises GET /metrics' aggregation math directly against a
// pre-seeded InMemoryCostRepository, rather than driving it through real
// classify/embed calls (that's covered manually — see docs/week-3-day-3.md's
// verification steps — since it needs real Claude/Bedrock usage numbers to
// be meaningful). This test is purely "given these CostRecords, does
// /metrics sum and group them correctly."

import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { beforeEach, describe, expect, it } from 'vitest';
import { documentRoutes, MAX_UPLOAD_SIZE_BYTES } from '../routes/documents.js';
import { InMemoryCostRepository } from '../repositories/inMemoryCostRepository.js';
import { InMemoryDocumentRepository } from '../repositories/inMemoryDocumentRepository.js';
import { InMemoryEmbeddingRepository } from '../repositories/inMemoryEmbeddingRepository.js';
import { InMemoryReviewQueueRepository } from '../repositories/inMemoryReviewQueueRepository.js';
import { MockEmbeddingGenerator } from '../services/mockEmbeddingGenerator.js';

describe('GET /metrics', () => {
  let app: FastifyInstance;
  let costRepo: InMemoryCostRepository;

  beforeEach(async () => {
    app = Fastify();
    costRepo = new InMemoryCostRepository();
    await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_SIZE_BYTES } });
    await app.register(documentRoutes, {
      repo: new InMemoryDocumentRepository(),
      embeddingRepo: new InMemoryEmbeddingRepository(),
      embeddingGenerator: new MockEmbeddingGenerator(),
      reviewQueueRepo: new InMemoryReviewQueueRepository(),
      costRepo,
    });
    await app.ready();
  });

  it('returns zeroed totals when nothing has been recorded yet', async () => {
    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      totalCostUsd: 0,
      requestCount: 0,
      byStage: [],
      averageCostPerDocumentUsd: 0,
    });
  });

  it('sums cost and request count per stage, and averages cost per distinct document', async () => {
    await costRepo.record({
      documentId: 'doc-1',
      stage: 'classification',
      modelId: 'claude-haiku-4-5-20251001',
      usage: { inputTokens: 1000, outputTokens: 1000 },
      costUsd: 0.006,
    });
    await costRepo.record({
      documentId: 'doc-1',
      stage: 'embedding',
      modelId: 'amazon.titan-embed-text-v2:0',
      usage: { inputTokens: 500, outputTokens: 0 },
      costUsd: 0.00001,
    });
    await costRepo.record({
      documentId: 'doc-2',
      stage: 'classification',
      modelId: 'claude-haiku-4-5-20251001',
      usage: { inputTokens: 800, outputTokens: 600 },
      costUsd: 0.0038,
    });

    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.requestCount).toBe(3);
    expect(body.totalCostUsd).toBeCloseTo(0.006 + 0.00001 + 0.0038, 10);

    const classificationStage = body.byStage.find((s: { stage: string }) => s.stage === 'classification');
    const embeddingStage = body.byStage.find((s: { stage: string }) => s.stage === 'embedding');

    expect(classificationStage.requestCount).toBe(2);
    expect(classificationStage.costUsd).toBeCloseTo(0.006 + 0.0038, 10);
    expect(embeddingStage.requestCount).toBe(1);
    expect(embeddingStage.costUsd).toBeCloseTo(0.00001, 10);

    // Two distinct documentIds (doc-1, doc-2) share the total cost.
    expect(body.averageCostPerDocumentUsd).toBeCloseTo((0.006 + 0.00001 + 0.0038) / 2, 10);
  });

  it('excludes null-cost records (unmapped model) from dollar totals but still counts the request', async () => {
    await costRepo.record({
      documentId: 'doc-1',
      stage: 'classification',
      modelId: 'some-unmapped-model',
      usage: { inputTokens: 100, outputTokens: 20 },
      costUsd: null,
    });

    const response = await app.inject({ method: 'GET', url: '/metrics' });
    const body = response.json();

    expect(body.requestCount).toBe(1);
    expect(body.totalCostUsd).toBe(0);
    expect(body.byStage[0].requestCount).toBe(1);
    expect(body.byStage[0].costUsd).toBe(0);
    expect(body.averageCostPerDocumentUsd).toBe(0);
  });
});
