import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { documentDetailSchema, uploadResponseSchema } from '../schemas/document.js';
import { getDocument, setDocument } from '../services/documentStore.js';
import { extractText } from '../services/extraction.js';
import { deleteUpload, getUploadPath, saveUpload } from '../services/storage.js';

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

    const filePath = getUploadPath(documentId);
    const extraction = await extractText(filePath);

    setDocument({
      documentId,
      filename: file.filename,
      filePath,
      extraction,
      uploadedAt: new Date(),
    });

    const extractionSummary =
      extraction.status === 'success'
        ? { status: extraction.status, pageCount: extraction.pageCount }
        : extraction;

    const response = uploadResponseSchema.parse({
      documentId,
      filename: file.filename,
      status: 'uploaded',
      extraction: extractionSummary,
    });

    return reply.status(201).send(response);
  });

  app.get<{ Params: { id: string } }>('/documents/:id', async (request, reply) => {
    const { id } = request.params;
    const record = getDocument(id);

    if (!record) {
      return reply.status(404).send({ error: `Document ${id} not found` });
    }

    const detail = documentDetailSchema.parse({
      documentId: record.documentId,
      filename: record.filename,
      uploadedAt: record.uploadedAt.toISOString(),
      extraction: record.extraction,
    });

    return reply.send(detail);
  });
}
