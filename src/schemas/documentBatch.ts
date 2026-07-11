import { z } from 'zod';
import { documentDetailSchema } from './document.js';

// How many documentIds a single batch-retrieval call accepts, and how many
// files a single batch-upload call accepts. Deliberately capped rather than
// unbounded — an unbounded batch size turns one HTTP request into an
// unpredictable amount of work (N database lookups, N file writes), which is
// the same "validate early, fail clearly" instinct as the single-upload
// route's file-size limit, just applied to request *shape* instead of file size.
export const MAX_BATCH_DOCUMENT_IDS = 100;
export const MAX_BATCH_UPLOAD_FILES = 20;

export const batchGetRequestSchema = z.object({
  documentIds: z.array(z.uuid()).min(1).max(MAX_BATCH_DOCUMENT_IDS),
});

export const batchGetResponseSchema = z.object({
  documents: z.array(documentDetailSchema),
  // IDs from the request that didn't match any stored document — a caller
  // managing many documents (e.g. "all documents for claim X") gets a
  // partial, still-useful response instead of the whole batch failing
  // because one ID was stale or mistyped.
  notFound: z.array(z.uuid()),
});

// One upload's outcome within a batch — a discriminated union (not a single
// shape with optional fields) so each item is unambiguously either a
// success or a rejection, mirroring the typed-result-union pattern already
// used throughout this project (ExtractionResult, ClassificationResult).
const batchUploadResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('uploaded'),
    documentId: z.uuid(),
    filename: z.string(),
    extraction: z.discriminatedUnion('status', [
      z.object({ status: z.literal('success'), pageCount: z.number() }),
      z.object({ status: z.literal('extraction_failed'), reason: z.string() }),
    ]),
  }),
  z.object({
    status: z.literal('rejected'),
    filename: z.string(),
    error: z.string(),
  }),
]);

export const batchUploadResponseSchema = z.object({
  documents: z.array(batchUploadResultSchema),
});

export type BatchGetRequest = z.infer<typeof batchGetRequestSchema>;
export type BatchGetResponse = z.infer<typeof batchGetResponseSchema>;
export type BatchUploadResult = z.infer<typeof batchUploadResultSchema>;
export type BatchUploadResponse = z.infer<typeof batchUploadResponseSchema>;
