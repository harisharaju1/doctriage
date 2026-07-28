// src/repositories/costRepository.ts
//
// Week 3 Day 3: one CostRecord per billable call (one classify call, one
// embed call per chunk, one query-embedding call) — NOT keyed by
// documentId the way DocumentRepository/ReviewQueueRepository are, since a
// single document legitimately produces multiple cost records over its
// lifetime. See docs/week-3-day-3.md.

import type { TokenUsage } from '../services/costTracking.js';

export interface CostRecord {
  documentId: string;
  stage: 'classification' | 'embedding';
  modelId: string;
  usage: TokenUsage;
  // null when costTracking.computeCostUsd had no pricing entry for modelId
  // — the record still counts toward request counts, just excluded from
  // dollar totals.
  costUsd: number | null;
  recordedAt: Date;
}

export interface CostRepository {
  record(entry: Omit<CostRecord, 'recordedAt'>): Promise<CostRecord>;
  list(): Promise<CostRecord[]>;
}
