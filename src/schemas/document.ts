import { z } from 'zod';

const extractionResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('success'), pageCount: z.number() }),
  z.object({ status: z.literal('extraction_failed'), reason: z.string() }),
]);

export const uploadResponseSchema = z.object({
  documentId: z.string().uuid(),
  filename: z.string(),
  status: z.literal('uploaded'),
  extraction: extractionResultSchema,
});

export const documentDetailSchema = z.object({
  documentId: z.string().uuid(),
  filename: z.string(),
  uploadedAt: z.string().datetime(),
  extraction: z.discriminatedUnion('status', [
    z.object({ status: z.literal('success'), pageCount: z.number(), text: z.string() }),
    z.object({ status: z.literal('extraction_failed'), reason: z.string() }),
  ]),
});

export type UploadResponse = z.infer<typeof uploadResponseSchema>;
export type DocumentDetail = z.infer<typeof documentDetailSchema>;
