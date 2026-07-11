// src/services/retrieval.ts
//
// This is the "R" in RAG (Retrieval-Augmented Generation) — given a
// question about a specific document, find the most relevant chunks of that
// document's text. Deliberately does NOT generate an answer from those
// chunks; that's a separate concern (generation) that depends on Day 3's
// real embedding/LLM work and isn't built yet. Today's job is purely: given
// a question, find the right source material.
//
// This function is intentionally thin — it exists so that the route handler
// (src/routes/documents.ts) doesn't need to know how embedding or similarity
// search work, the same separation of concerns already established between
// routes and services/classifier.ts for the classification call.

import type { ChunkEmbeddingRecord, EmbeddingRepository } from '../repositories/embeddingRepository.js';
import { generateMockEmbedding } from './embedding.js';

export async function findRelevantChunks(
  embeddingRepo: EmbeddingRepository,
  documentId: string,
  questionText: string,
  limit: number,
): Promise<Array<ChunkEmbeddingRecord & { distance: number }>> {
  // The question gets embedded with the exact same function used to embed
  // the document's chunks (generateMockEmbedding). This has to match: a
  // question embedded with one method and chunks embedded with a different
  // method would live in two unrelated vector spaces, where "distance"
  // between them means nothing. This symmetry requirement carries forward
  // unchanged once Day 3 swaps in a real embedding model — questions and
  // chunks always need to go through the same embedding function.
  const questionEmbedding = generateMockEmbedding(questionText);

  return embeddingRepo.findSimilarInDocument(documentId, questionEmbedding, limit);
}
