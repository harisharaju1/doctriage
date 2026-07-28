import { z } from 'zod';

export const metricsStageSchema = z.object({
  stage: z.string(),
  costUsd: z.number(),
  requestCount: z.number().int(),
});

export const metricsResponseSchema = z.object({
  // Sum of only non-null CostRecord.costUsd entries — a record with
  // costUsd: null (unmapped model) is excluded from this total but still
  // counted in requestCount, per costTracking.ts's "never break the
  // request" design.
  totalCostUsd: z.number(),
  requestCount: z.number().int(),
  byStage: z.array(metricsStageSchema),
  averageCostPerDocumentUsd: z.number(),
});
