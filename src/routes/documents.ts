import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { uploadResponseSchema } from '../schemas/document.js';
import { deleteUpload, saveUpload } from '../services/storage.js';

export const ALLOWED_MIME_TYPE = 'application/pdf';
export const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/documents', async (request, reply) => {
    const file = await request.file();

    if (!file) {
      return reply.status(400).send({ error: 'No file provided. Send a PDF as multipart/form-data.' });
    }

    if (file.mimetype !== ALLOWED_MIME_TYPE) {
      return reply
        .status(400)
        .send({ error: `Unsupported file type: ${file.mimetype}. Only ${ALLOWED_MIME_TYPE} is accepted.` });
    }

    const documentId = randomUUID();
    await saveUpload(documentId, file.file);

    if (file.file.truncated) {
      await deleteUpload(documentId);
      return reply
        .status(400)
        .send({ error: `File exceeds the ${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB size limit.` });
    }

    const response = uploadResponseSchema.parse({
      documentId,
      filename: file.filename,
      status: 'uploaded',
    });

    return reply.status(201).send(response);
  });
}
