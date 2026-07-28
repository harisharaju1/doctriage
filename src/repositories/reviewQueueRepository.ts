// src/repositories/reviewQueueRepository.ts
//
// Week 3 Day 2: the source of truth for classifications that came back
// schema-valid but below CLASSIFICATION_CONFIDENCE_THRESHOLD — see
// docs/week-3-day-2.md's "Deciding what 'below threshold' actually does to
// the document record" for why this queue, not DocumentRecord.classification,
// is where an unresolved low-confidence result lives until a human acts on
// it. Same interface-plus-in-memory-implementation shape as
// DocumentRepository — nothing about this data needs Postgres/Mongo
// durability today, so there's no forcing reason to reach past an in-memory
// Map yet.

import type { Classification } from '../schemas/classification.js';

export interface ReviewQueueEntry {
  documentId: string;
  // The below-threshold result itself — a human needs to see what the model
  // guessed (and its stated reasoning) to make an informed correction, not
  // just "this document needs review."
  classification: Classification;
  // e.g. "confidence 0.42 is below the 0.70 threshold" — human-readable,
  // not machine-parsed.
  reason: string;
  queuedAt: Date;
}

export interface ReviewQueueRepository {
  enqueue(entry: Omit<ReviewQueueEntry, 'queuedAt'>): Promise<ReviewQueueEntry>;
  list(): Promise<ReviewQueueEntry[]>;
  findByDocumentId(documentId: string): Promise<ReviewQueueEntry | undefined>;
  // Removes the entry once a human has resolved it — a resolved document has
  // no unresolved queue entry left to find, the same way a document that was
  // never queued doesn't either.
  resolve(documentId: string): Promise<void>;
}
