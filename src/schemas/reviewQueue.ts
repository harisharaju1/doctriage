import { z } from 'zod';
import { classificationSchema } from './classification.js';

// Week 3 Day 2: POST /review-queue/:documentId/resolve's request body — a
// human supplies the correct documentType. Reuses the same enum
// classificationSchema.documentType uses (via .shape.documentType) rather
// than redeclaring the list of document types a second place that could
// drift out of sync with it.
export const resolveReviewRequestSchema = z.object({
  documentType: classificationSchema.shape.documentType,
});

// GET /documents/:id/classify's below-threshold response — deliberately
// distinct from a bare Classification object (which has no `status` field)
// so a caller can tell, from shape alone, that this result was NOT
// persisted/trusted and instead requires a human to resolve it via
// POST /review-queue/:documentId/resolve.
export const pendingReviewResponseSchema = z.object({
  status: z.literal('pending_review'),
  classification: classificationSchema,
  reason: z.string(),
});

export const reviewQueueEntrySchema = z.object({
  documentId: z.string(),
  classification: classificationSchema,
  reason: z.string(),
  queuedAt: z.string(),
});

export const reviewQueueListResponseSchema = z.object({
  items: z.array(reviewQueueEntrySchema),
});
