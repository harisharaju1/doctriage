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

