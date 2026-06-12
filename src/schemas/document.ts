import { z } from 'zod';

export const uploadResponseSchema = z.object({
  documentId: z.string().uuid(),
  filename: z.string(),
  status: z.literal('uploaded'),
});

export type UploadResponse = z.infer<typeof uploadResponseSchema>;
