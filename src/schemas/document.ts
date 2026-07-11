import { z } from 'zod';
import { classificationSchema } from './classification.js';

const extractionResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('success'), pageCount: z.number() }),
  z.object({ status: z.literal('extraction_failed'), reason: z.string() }),
]);

export const uploadResponseSchema = z.object({
  documentId: z.uuid(),
  filename: z.string(),
  status: z.literal('uploaded'),
  extraction: extractionResultSchema,
});

// `classification` and `chunksStored` are both optional/nullable-shaped
// pieces of a document's lifecycle, not always-present fields — a freshly
// uploaded document has neither. They're included here (not split into a
// separate schema) so GET /documents/:id and POST /documents/batch return
// the exact same shape — a caller assembling "everything about N documents"
// gets identical fields whether they fetched one document or many. See
// docs/week-2-day-2-dot-5.md for the reasoning.
export const documentDetailSchema = z.object({
  documentId: z.uuid(),
  filename: z.string(),
  uploadedAt: z.iso.datetime(),
  extraction: z.discriminatedUnion('status', [
    z.object({ status: z.literal('success'), pageCount: z.number(), text: z.string() }),
    z.object({ status: z.literal('extraction_failed'), reason: z.string() }),
  ]),
  // Undefined until /classify has succeeded at least once for this document.
  classification: classificationSchema.optional(),
  // How many chunks are currently stored for this document via /embed — 0
  // means "never embedded," matching countChunksForDocument's semantics.
  chunksStored: z.number().int().nonnegative(),
});

export type UploadResponse = z.infer<typeof uploadResponseSchema>;
export type DocumentDetail = z.infer<typeof documentDetailSchema>;
