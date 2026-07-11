import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import type { DocumentRecord, DocumentRepository } from '../repositories/documentRepository.js';
import type { EmbeddingRepository } from '../repositories/embeddingRepository.js';
import { documentDetailSchema, uploadResponseSchema, type DocumentDetail } from '../schemas/document.js';
import {
  batchGetRequestSchema,
  batchGetResponseSchema,
  batchUploadResponseSchema,
  MAX_BATCH_UPLOAD_FILES,
  type BatchUploadResult,
} from '../schemas/documentBatch.js';
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

  // Shared by POST /documents (single) and POST /documents/batch-upload —
  // validates one file, saves + extracts it, and returns a typed
  // success/rejection result instead of throwing or replying directly. This
  // is what lets batch-upload process 20 files and report per-file outcomes
  // (one bad mimetype shouldn't sink 19 good uploads) while the single
  // upload route below can still return its familiar single-object response
  // by unwrapping this same result. See docs/week-2-day-2-dot-5.md.
  async function processUpload(file: MultipartFile): Promise<BatchUploadResult> {
    if (file.mimetype !== ALLOWED_MIME_TYPE) {
      // @fastify/multipart's request.files() async iterator (used by
      // POST /documents/batch-upload below) will not yield the NEXT file in
      // a multi-file request until the CURRENT file's stream has been fully
      // consumed — that's how it knows the current part is done. Returning
      // here without ever reading `file.file` leaves that stream un-drained,
      // which silently hangs the iterator forever on any request with more
      // than one file. `.resume()` discards the stream's contents without
      // buffering them anywhere, satisfying that requirement even though we
      // have no use for the bytes of a file we're rejecting anyway.
      file.file.resume();
      return {
        status: 'rejected',
        filename: file.filename,
        error: `Unsupported file type: ${file.mimetype}. Only ${ALLOWED_MIME_TYPE} is accepted.`,
      };
    }

    const documentId = randomUUID();
    await saveUpload(documentId, file.file);

    if (file.file.truncated) {
      await deleteUpload(documentId);
      return {
        status: 'rejected',
        filename: file.filename,
        error: `File exceeds the ${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB size limit.`,
      };
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

    return {
      status: 'uploaded',
      documentId,
      filename: file.filename,
      extraction: extractionSummary,
    };
  }

  // Shared by GET /documents/:id and POST /documents/batch — assembles the
  // exact same "everything about this document" shape both ways, so a
  // caller gets identical fields whether they fetched one document or many.
  async function toDocumentDetail(record: DocumentRecord): Promise<DocumentDetail> {
    const chunksStored = await embeddingRepo.countChunksForDocument(record.documentId);

    return documentDetailSchema.parse({
      documentId: record.documentId,
      filename: record.filename,
      uploadedAt: record.uploadedAt.toISOString(),
      extraction: record.extraction,
      classification: record.classification,
      chunksStored,
    });
  }

  app.post('/documents', async (request, reply) => {
    const file = await request.file();

    if (!file) {
      return reply.status(400).send({ error: 'No file provided. Send a PDF as multipart/form-data.' });
    }

    const result = await processUpload(file);

    if (result.status === 'rejected') {
      return reply.status(400).send({ error: result.error });
    }

    const response = uploadResponseSchema.parse({
      documentId: result.documentId,
      filename: result.filename,
      status: 'uploaded',
      extraction: result.extraction,
    });

    return reply.status(201).send(response);
  });

  // Accepts multiple files in one multipart/form-data request (repeated
  // `file` fields) and uploads/extracts each independently. Deliberately a
  // SEPARATE endpoint from POST /documents above, rather than changing that
  // route's response shape — existing single-upload callers keep working
  // unchanged, and "upload N files" is a genuinely different response shape
  // (an array of per-file outcomes, some of which may be rejections) than
  // "upload one file." See docs/week-2-day-2-dot-5.md.
  app.post('/documents/batch-upload', async (request, reply) => {
    const results: BatchUploadResult[] = [];

    // Capped at MAX_BATCH_UPLOAD_FILES for the same reason the single-upload
    // route caps file size: an unbounded batch turns one HTTP request into
    // an unpredictable amount of work. Files beyond the cap are simply not
    // read from the stream — a simplification worth naming rather than
    // hiding: this doesn't report how many were skipped, it just stops.
    for await (const file of request.files()) {
      if (results.length >= MAX_BATCH_UPLOAD_FILES) {
        break;
      }
      results.push(await processUpload(file));
    }

    if (results.length === 0) {
      return reply.status(400).send({ error: 'No files provided. Send one or more PDFs as multipart/form-data.' });
    }

    const response = batchUploadResponseSchema.parse({ documents: results });
    return reply.send(response);
  });

  app.get<{ Params: { id: string } }>('/documents/:id', async (request, reply) => {
    const { id } = request.params;
    const record = await repo.findById(id);

    if (!record) {
      return reply.status(404).send({ error: `Document ${id} not found` });
    }

    return reply.send(await toDocumentDetail(record));
  });

  // Accepts a list of documentIds and returns full details for all of them
  // in one call — the direct answer to "I don't want a user entity in this
  // service, but I still want everything for a set of documents in one
  // request." The caller supplies the IDs (they already have them, one per
  // upload response); this service never needs to know what groups them
  // together. See docs/week-2-day-2-dot-5.md for the full reasoning.
  app.post<{ Body: unknown }>('/documents/batch', async (request, reply) => {
    const parsedBody = batchGetRequestSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsedBody.error.issues });
    }

    const notFound: string[] = [];
    const documents: DocumentDetail[] = [];

    // Sequential lookups here (not Promise.all) intentionally keep this
    // implementation identical in shape to a single WHERE id = ANY($1) query
    // once documents move to a real database — Promise.all would fire N
    // concurrent lookups against the SAME in-memory Map/eventual DB
    // connection pool for no real benefit at this project's scale, and
    // reads less obviously like "this becomes one query later."
    for (const documentId of parsedBody.data.documentIds) {
      const record = await repo.findById(documentId);
      if (!record) {
        notFound.push(documentId);
        continue;
      }
      documents.push(await toDocumentDetail(record));
    }

    const response = batchGetResponseSchema.parse({ documents, notFound });
    return reply.send(response);
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

    // Persist the classification onto the document record — previously this
    // route returned the result without saving it anywhere, which meant a
    // later GET or batch-retrieval call had no way to know a document had
    // ever been classified. See docs/week-2-day-2-dot-5.md.
    await repo.save({ ...record, classification: result.classification });

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
