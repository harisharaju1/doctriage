import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { loadEnv } from '../config/env.js';
import type { CostRepository } from '../repositories/costRepository.js';
import type { DocumentRecord, DocumentRepository } from '../repositories/documentRepository.js';
import type { EmbeddingRepository } from '../repositories/embeddingRepository.js';
import type { ReviewQueueRepository } from '../repositories/reviewQueueRepository.js';
import { classifyRequestSchema, type Classification } from '../schemas/classification.js';
import { documentDetailSchema, uploadResponseSchema, type DocumentDetail } from '../schemas/document.js';
import {
  batchGetRequestSchema,
  batchGetResponseSchema,
  batchUploadResponseSchema,
  MAX_BATCH_UPLOAD_FILES,
  type BatchUploadResult,
} from '../schemas/documentBatch.js';
import { embedResponseSchema, queryRequestSchema, queryResponseSchema } from '../schemas/embedding.js';
import { metricsResponseSchema } from '../schemas/metrics.js';
import {
  pendingReviewResponseSchema,
  resolveReviewRequestSchema,
  reviewQueueListResponseSchema,
} from '../schemas/reviewQueue.js';
import { classifyDocument, MODEL as CLASSIFICATION_MODEL } from '../services/classifier.js';
import { chunkText } from '../services/chunking.js';
import { computeCostUsd } from '../services/costTracking.js';
import type { EmbeddingGenerator } from '../services/embeddingGenerator.js';
import { extractText } from '../services/extraction.js';
import { findRelevantChunks } from '../services/retrieval.js';
import { deleteUpload, getUploadPath, saveUpload } from '../services/storage.js';

const env = loadEnv();

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
  // Injected rather than imported directly — as of Week 2 Day 3, this can be
  // MockEmbeddingGenerator (tests, zero AWS credentials needed) or
  // BedrockEmbeddingGenerator (production, real Titan calls). See
  // src/services/embeddingGenerator.ts's header for why this is an
  // interface at all, not just a same-signature function swap.
  embeddingGenerator: EmbeddingGenerator;
  // Week 3 Day 2: source of truth for below-threshold classifications
  // awaiting human resolution. See docs/week-3-day-2.md.
  reviewQueueRepo: ReviewQueueRepository;
  // Week 3 Day 3: one record per billable call, surfaced via GET /metrics.
  // See docs/week-3-day-3.md.
  costRepo: CostRepository;
}

export async function documentRoutes(
  app: FastifyInstance,
  opts: DocumentRouteOptions,
): Promise<void> {
  const { repo, embeddingRepo, embeddingGenerator, reviewQueueRepo, costRepo } = opts;

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

  app.post<{ Params: { id: string }; Body: unknown }>('/documents/:id/classify', async (request, reply) => {
    const { id } = request.params;
    // Week 3 Day 1: bound once, passed into every service call below, so
    // every log line this request produces — including classifyDocument's
    // retry/corrective-retry attempts — carries this documentId alongside
    // Fastify's own reqId. See docs/week-3-day-1.md.
    const log = request.log.child({ documentId: id });

    // Week 2 Day 4: this route's body is entirely OPTIONAL — every caller
    // from before today sends no body at all, and that must keep working
    // unchanged. `request.body` is `undefined` (no body sent) or `null`
    // (some clients send an empty JSON body) in that case, neither of which
    // classifyRequestSchema — a z.object() — would accept directly, so
    // those are normalized to `{}` before parsing. A body that IS present
    // but malformed (e.g. promptVersion sent as a number) still fails
    // validation and returns a 400, same "validate early, fail clearly"
    // pattern used by /documents/batch and /documents/:id/query.
    const parsedBody = classifyRequestSchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsedBody.error.issues });
    }

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

    // promptVersion is undefined unless the caller explicitly requested one
    // — classifyDocument treats undefined as "use the registry's current
    // default," so this is a pure pass-through, not a place that needs to
    // know what the default actually is.
    let result;
    try {
      result = await classifyDocument(record.extraction.text, undefined, parsedBody.data.promptVersion, log);
    } catch (err) {
      // getClassificationPrompt (called inside classifyDocument) throws
      // synchronously-from-the-caller's-perspective on an unknown
      // promptVersion — e.g. { "promptVersion": "v3" } when only v1/v2
      // exist. That's a client input error (they asked for something that
      // doesn't exist), not an upstream Claude failure, so it's a 400 here,
      // not the 502 used below for genuine Claude-call failures.
      const reason = err instanceof Error ? err.message : 'Invalid prompt version';
      return reply.status(400).send({ error: 'Invalid prompt version', reason });
    }

    // Week 3 Day 3: recorded regardless of outcome — a classification that
    // ultimately failed after retries still spent real tokens getting
    // there. See docs/week-3-day-3.md's "Usage has to be summed across
    // retries".
    await costRepo.record({
      documentId: id,
      stage: 'classification',
      modelId: CLASSIFICATION_MODEL,
      usage: result.usage,
      costUsd: computeCostUsd(CLASSIFICATION_MODEL, result.usage),
    });

    if (result.status === 'classification_failed') {
      return reply.status(502).send({
        error: 'Classification failed',
        reason: result.reason,
      });
    }

    // Week 3 Day 2: a schema-valid classification that's genuinely
    // uncertain isn't trustworthy just because it parsed — route it to the
    // human review queue instead of persisting it as-is. See
    // docs/week-3-day-2.md's "Deciding what 'below threshold' actually does
    // to the document record" for why this is NOT persisted onto
    // record.classification: that field's meaning stays "trustworthy" only,
    // never "trustworthy, unless you also happen to check the queue."
    if (result.classification.confidence < env.CLASSIFICATION_CONFIDENCE_THRESHOLD) {
      const reason = `confidence ${result.classification.confidence} is below the ${env.CLASSIFICATION_CONFIDENCE_THRESHOLD} threshold`;
      log.info(
        { confidence: result.classification.confidence, threshold: env.CLASSIFICATION_CONFIDENCE_THRESHOLD },
        'confidence below threshold — routed to human review queue',
      );
      await reviewQueueRepo.enqueue({ documentId: id, classification: result.classification, reason });

      const response = pendingReviewResponseSchema.parse({
        status: 'pending_review',
        classification: result.classification,
        reason,
      });
      return reply.send(response);
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
    // Week 3 Day 1: see the identical binding on /documents/:id/classify above.
    const log = request.log.child({ documentId: id });
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

    // As of Week 2 Day 3, embeddingGenerator.generate() is a real network
    // call (Bedrock in production), not the synchronous mock function this
    // used to be — so this can no longer be a plain `.map()` the way it was
    // through Day 2. Deliberately SEQUENTIAL (`for...of` + `await`, not
    // `Promise.all`) rather than firing every chunk's embedding call
    // concurrently: concurrent calls would finish faster, but they'd also
    // hit Bedrock's per-account rate limit sooner on a document with many
    // chunks, defeating some of the point of the retry/backoff logic already
    // built into BedrockEmbeddingGenerator. Sequential is slower but gentler
    // and easier to reason about — a reasonable default to revisit if
    // embedding latency on large documents ever becomes a real bottleneck.
    //
    // Wrapped in try/catch: BedrockEmbeddingGenerator has already exhausted
    // its own retries (withRetry, inside generate()) by the time an error
    // reaches here, so anything that throws past that point is a genuine,
    // final failure — a bad/expired credential, a persistently unreachable
    // Bedrock endpoint, etc. Without this catch, that error would fall
    // through to Fastify's default handler as a bare 500 "Internal Server
    // Error" — technically "not a crash," but not the typed, designed
    // failure response every other external-API call in this project
    // returns (compare /classify's 502 handling for a failed Claude call).
    // Same 502 convention here: the upstream dependency failed, not the
    // client's request.
    const chunksWithEmbeddings: Array<{ chunkIndex: number; chunkText: string; embedding: number[] }> = [];
    try {
      for (const chunk of chunks) {
        const { embedding, usage } = await embeddingGenerator.generate(chunk.text, log);
        chunksWithEmbeddings.push({ chunkIndex: chunk.index, chunkText: chunk.text, embedding });
        // Week 3 Day 3: one record per chunk, not one aggregate per
        // document — each chunk is its own billable Bedrock call. See
        // docs/week-3-day-3.md.
        await costRepo.record({
          documentId: id,
          stage: 'embedding',
          modelId: env.AWS_BEDROCK_EMBEDDING_MODEL_ID,
          usage,
          costUsd: computeCostUsd(env.AWS_BEDROCK_EMBEDDING_MODEL_ID, usage),
        });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Embedding generation failed';
      return reply.status(502).send({ error: 'Embedding failed', reason });
    }

    // replaceChunksForDocument (not insert-per-chunk) is what makes calling
    // this route a second time for the same document safe — it deletes any
    // previously-stored chunks and inserts the fresh set as one atomic
    // transaction, rather than piling up duplicates next to stale ones. See
    // the "database transactions" section of docs/week-2-day-2.md.
    const inserted = await embeddingRepo.replaceChunksForDocument(id, chunksWithEmbeddings);

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
      // Week 3 Day 1: see the identical binding on /documents/:id/classify above.
      const log = request.log.child({ documentId: id });
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

      const { matches, usage } = await findRelevantChunks(
        embeddingRepo,
        embeddingGenerator,
        id,
        parsedBody.data.question,
        DEFAULT_QUERY_MATCH_LIMIT,
        log,
      );

      // Week 3 Day 3: the question embedding is a real Bedrock call too —
      // recorded under the same 'embedding' stage as document-chunk
      // embedding, deliberately not a separate 'query' stage. See
      // docs/week-3-day-3.md.
      await costRepo.record({
        documentId: id,
        stage: 'embedding',
        modelId: env.AWS_BEDROCK_EMBEDDING_MODEL_ID,
        usage,
        costUsd: computeCostUsd(env.AWS_BEDROCK_EMBEDDING_MODEL_ID, usage),
      });

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

  // Week 3 Day 2: lists documents whose classification came back
  // schema-valid but below CLASSIFICATION_CONFIDENCE_THRESHOLD, awaiting a
  // human's resolution. See docs/week-3-day-2.md.
  app.get('/review-queue', async (_request, reply) => {
    const items = await reviewQueueRepo.list();

    const response = reviewQueueListResponseSchema.parse({
      items: items.map((item) => ({
        documentId: item.documentId,
        classification: item.classification,
        reason: item.reason,
        queuedAt: item.queuedAt.toISOString(),
      })),
    });

    return reply.send(response);
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/review-queue/:id/resolve',
    async (request, reply) => {
      const { id } = request.params;
      const log = request.log.child({ documentId: id });

      const parsedBody = resolveReviewRequestSchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.status(400).send({ error: 'Invalid request body', details: parsedBody.error.issues });
      }

      const entry = await reviewQueueRepo.findByDocumentId(id);
      if (!entry) {
        return reply.status(404).send({ error: `No pending review for document ${id}` });
      }

      const record = await repo.findById(id);
      if (!record) {
        return reply.status(404).send({ error: `Document ${id} not found` });
      }

      // A human resolution is, by construction, maximally trusted — there's
      // no further retry/corrective-retry step past this point the way
      // classifyDocument has for a model response. See docs/week-3-day-2.md's
      // "What a human 'resolving' a review item actually produces" for why
      // this builds a real Classification rather than persisting a bare
      // documentType string — every downstream consumer of `classification`
      // stays unaware of whether it came from Claude or a human.
      const classification: Classification = {
        documentType: parsedBody.data.documentType,
        confidence: 1,
        reasoning: 'Manually resolved via human review queue.',
      };

      await repo.save({ ...record, classification });
      await reviewQueueRepo.resolve(id);
      log.info({ documentType: classification.documentType }, 'review queue entry resolved');

      return reply.send(classification);
    },
  );

  // Week 3 Day 3: total cost, cost + request count per stage, and average
  // cost per document, aggregated from every CostRecord recorded so far.
  // See docs/week-3-day-3.md.
  app.get('/metrics', async (_request, reply) => {
    const records = await costRepo.list();

    let totalCostUsd = 0;
    const byStage = new Map<string, { costUsd: number; requestCount: number }>();
    const documentIds = new Set<string>();

    for (const record of records) {
      documentIds.add(record.documentId);

      const stageEntry = byStage.get(record.stage) ?? { costUsd: 0, requestCount: 0 };
      stageEntry.requestCount += 1;
      // costUsd: null (unmapped model) is excluded from dollar totals but
      // the record still counted above toward requestCount — see
      // costTracking.ts's "never break the request" design.
      if (record.costUsd !== null) {
        stageEntry.costUsd += record.costUsd;
        totalCostUsd += record.costUsd;
      }
      byStage.set(record.stage, stageEntry);
    }

    const response = metricsResponseSchema.parse({
      totalCostUsd,
      requestCount: records.length,
      byStage: [...byStage.entries()].map(([stage, { costUsd, requestCount }]) => ({
        stage,
        costUsd,
        requestCount,
      })),
      averageCostPerDocumentUsd: documentIds.size > 0 ? totalCostUsd / documentIds.size : 0,
    });

    return reply.send(response);
  });
}
