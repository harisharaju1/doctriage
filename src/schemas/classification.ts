import { z } from 'zod';

export const classificationSchema = z.object({
  documentType: z.enum([
    'claim_form',
    'medical_report',
    'police_report',
    'repair_estimate',
    'other',
  ]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export type Classification = z.infer<typeof classificationSchema>;

// Week 2 Day 4: the (optional) request body for POST /documents/:id/classify.
// Before today this route ignored request.body entirely — there was nothing
// to configure about a classify call. promptVersion is the one new knob:
// omitted entirely (or an empty body/no body at all), the route falls
// through to classifyDocument's own default (registry.ts's
// CURRENT_CLASSIFICATION_VERSION). Explicit, unknown version strings are
// still accepted by this schema (it's just a string) — the meaningful
// "does this version exist" check happens in getClassificationPrompt, which
// throws a clear, named error rather than this schema trying to duplicate
// that knowledge and risk drifting out of sync with the registry.
export const classifyRequestSchema = z.object({
  promptVersion: z.string().optional(),
});

