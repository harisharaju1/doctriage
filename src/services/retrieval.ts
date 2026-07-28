// src/services/retrieval.ts
//
// This is the "R" in RAG (Retrieval-Augmented Generation) — given a
// question about a specific document, find the most relevant chunks of that
// document's text. Deliberately does NOT generate an answer from those
// chunks; that's a separate concern (generation) that isn't built yet.
// Today's job is purely: given a question, find the right source material.
//
// This function is intentionally thin — it exists so that the route handler
// (src/routes/documents.ts) doesn't need to know how embedding or similarity
// search work, the same separation of concerns already established between
// routes and services/classifier.ts for the classification call.

import type { FastifyBaseLogger } from 'fastify';
import type { ChunkEmbeddingRecord, EmbeddingRepository } from '../repositories/embeddingRepository.js';
import type { TokenUsage } from './costTracking.js';
import type { EmbeddingGenerator } from './embeddingGenerator.js';

export async function findRelevantChunks(
  embeddingRepo: EmbeddingRepository,
  embeddingGenerator: EmbeddingGenerator,
  documentId: string,
  questionText: string,
  limit: number,
  // Week 3 Day 1: optional request-scoped logger, passed straight through
  // to embeddingGenerator.generate(). findRelevantChunks itself logs
  // nothing today — this parameter exists so the route handler has one
  // consistent way to thread its documentId-bound logger through the whole
  // call chain, not one that breaks at this function. See
  // docs/week-3-day-1.md.
  logger?: FastifyBaseLogger,
  // Week 3 Day 3: the question embedding is a real Bedrock call and costs
  // real tokens too — its usage now travels back out to the caller
  // alongside the matches, the same way document-chunk embedding usage
  // does. See docs/week-3-day-3.md.
): Promise<{ matches: Array<ChunkEmbeddingRecord & { distance: number }>; usage: TokenUsage }> {
  // The question gets embedded with the exact same generator used to embed
  // the document's chunks (both are the SAME EmbeddingGenerator instance,
  // injected from server.ts). This has to match: a question embedded with
  // one model and chunks embedded with a different model would live in two
  // unrelated vector spaces, where "distance" between them means nothing.
  // Passing embeddingGenerator in as a parameter (rather than importing a
  // concrete implementation directly, the way this file did through Day 2)
  // is what guarantees that symmetry can never accidentally break — there's
  // only one EmbeddingGenerator in play per request, wired up once in
  // server.ts, not two different imports that could drift out of sync.
  const { embedding: questionEmbedding, usage } = await embeddingGenerator.generate(questionText, logger);

  const matches = await embeddingRepo.findSimilarInDocument(documentId, questionEmbedding, limit);
  return { matches, usage };
}
