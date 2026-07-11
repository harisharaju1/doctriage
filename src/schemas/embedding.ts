import { z } from 'zod';

// Response for POST /documents/:id/embed — deliberately thin. Callers don't
// need the chunk text or embeddings back here (they can retrieve those via
// /query); they need confirmation of what happened.
export const embedResponseSchema = z.object({
  documentId: z.uuid(),
  chunksStored: z.number().int().nonnegative(),
});

// Request body for POST /documents/:id/query. `.min(1)` rejects an empty
// question at the validation layer — same "validate early, fail clearly"
// instinct as the upload route's file-type/size checks (Week 1 Day 2) —
// rather than letting an empty string silently flow into
// generateMockEmbedding() and produce a meaningless all-zero vector.
export const queryRequestSchema = z.object({
  question: z.string().min(1, 'question must not be empty'),
});

export const queryResponseSchema = z.object({
  documentId: z.uuid(),
  matches: z.array(
    z.object({
      chunkText: z.string(),
      chunkIndex: z.number().int().nonnegative(),
      // Cosine distance from pgvector's `<=>` operator — smaller means more
      // relevant. Included in the response (not just used internally to
      // rank) so a future caller (a UI, or later synthesis logic) can decide
      // for itself how to treat weak matches, rather than that threshold
      // being a hidden decision baked into this schema.
      distance: z.number(),
    }),
  ),
});

export type EmbedResponse = z.infer<typeof embedResponseSchema>;
export type QueryRequest = z.infer<typeof queryRequestSchema>;
export type QueryResponse = z.infer<typeof queryResponseSchema>;
