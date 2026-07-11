import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DocumentRepository } from '../repositories/documentRepository.js';
import type { EmbeddingRepository } from '../repositories/embeddingRepository.js';
import { documentDetailSchema, uploadResponseSchema } from '../schemas/document.js';
import { embedResponseSchema, queryRequestSchema, queryResponseSchema } from '../schemas/embedding.js';
import { classifyDocument } from '../services/classifier.js';
import { chunkText } from '../services/chunking.js';
import { generateMockEmbedding } from '../services/embedding.js';
import { extractText } from '../services/extraction.js';
import { findRelevantChunks } from '../services/retrieval.js';
import { deleteUpload, getUploadPath, saveUpload } from '../services/storage.js';

export const ALLOWED_MIME_TYPE = 'application/pdf';
export const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

// How many chunks a single /query call returns. A fixed constant for now —
// not yet exposed as a request parameter, since nothing downstream (there's
// no answer-synthesis step yet) needs a caller-tunable value. Revisit once
// that changes.
const DEFAULT_QUERY_MATCH_LIMIT = 5;

interface DocumentRouteOptions {
  repo: DocumentRepository;
  embeddingRepo: EmbeddingRepository;
}

export async function documentRoutes(
  app: FastifyInstance,
  opts: DocumentRouteOptions,
): Promise<void> {
  const { repo, embeddingRepo } = opts;

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

    await repo.save({
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
    const record = await repo.findById(id);

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

  app.post<{ Params: { id: string } }>('/documents/:id/classify', async (request, reply) => {
    const { id } = request.params;
    const record = await repo.findById(id);

    if (!record) {
      return reply.status(404).send({ error: `Document ${id} not found` });
    }

    if (record.extraction.status === 'extraction_failed') {
      return reply.status(422).send({
        error: 'Cannot classify document — text extraction failed',
        reason: record.extraction.reason,
      });
    }

    const result = await classifyDocument(record.extraction.text);

    if (result.status === 'classification_failed') {
      return reply.status(502).send({
        error: 'Classification failed',
        reason: result.reason,
      });
    }

    return reply.send(result.classification);
  });

  app.post<{ Params: { id: string } }>('/documents/:id/embed', async (request, reply) => {
    const { id } = request.params;
    const record = await repo.findById(id);

    if (!record) {
      return reply.status(404).send({ error: `Document ${id} not found` });
    }

    // Same guard /classify already uses: there's no text to chunk if
    // extraction never produced any.
    if (record.extraction.status === 'extraction_failed') {
      return reply.status(422).send({
        error: 'Cannot embed document — text extraction failed',
        reason: record.extraction.reason,
      });
    }

    const chunks = chunkText(record.extraction.text);

    // replaceChunksForDocument (not insert-per-chunk) is what makes calling
    // this route a second time for the same document safe — it deletes any
    // previously-stored chunks and inserts the fresh set as one atomic
    // transaction, rather than piling up duplicates next to stale ones. See
    // the "database transactions" section of docs/week-2-day-2.md.
    const inserted = await embeddingRepo.replaceChunksForDocument(
      id,
      chunks.map((chunk) => ({
        chunkIndex: chunk.index,
        chunkText: chunk.text,
        // Still Day 1's mock generator — real embeddings arrive Day 3. The
        // pipeline shape (chunk → embed → store) doesn't change when that swap happens.
        embedding: generateMockEmbedding(chunk.text),
      })),
    );

    const response = embedResponseSchema.parse({
      documentId: id,
      chunksStored: inserted.length,
    });

    return reply.send(response);
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/documents/:id/query',
    async (request, reply) => {
      const { id } = request.params;
      const record = await repo.findById(id);

      if (!record) {
        return reply.status(404).send({ error: `Document ${id} not found` });
      }

      // Validate the request body against the Zod schema before doing any
      // work — same "validate early, fail clearly" instinct used throughout
      // this project. safeParse (not parse) here because this is validating
      // untrusted CLIENT input, not our own internal response construction —
      // a malformed request body is an expected case to handle with a 400,
      // not an exceptional one to throw on.
      const parsedBody = queryRequestSchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.status(400).send({ error: 'Invalid request body', details: parsedBody.error.issues });
      }

      // Distinguishes "never embedded" (422 — caller needs to hit /embed
      // first) from "embedded, but nothing matched well" (a legitimate
      // empty/weak result from findRelevantChunks) — see the comment on
      // countChunksForDocument in embeddingRepository.ts for why this can't
      // be inferred from an empty match list alone.
      const chunkCount = await embeddingRepo.countChunksForDocument(id);
      if (chunkCount === 0) {
        return reply.status(422).send({
          error: 'Document has not been embedded yet — call POST /documents/:id/embed first',
        });
      }

      const matches = await findRelevantChunks(
        embeddingRepo,
        id,
        parsedBody.data.question,
        DEFAULT_QUERY_MATCH_LIMIT,
      );

      const response = queryResponseSchema.parse({
        documentId: id,
        matches: matches.map((match) => ({
          chunkText: match.chunkText,
          chunkIndex: match.chunkIndex,
          distance: match.distance,
        })),
      });

      return reply.send(response);
    },
  );
}
