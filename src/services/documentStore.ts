import type { ExtractionResult } from './extraction.js';

export interface DocumentRecord {
  documentId: string;
  filename: string;
  filePath: string;
  extraction: ExtractionResult;
  uploadedAt: Date;
}

// In-memory store — replaced by MongoDB in Week 2
const store = new Map<string, DocumentRecord>();

export function setDocument(record: DocumentRecord): void {
  store.set(record.documentId, record);
}

export function getDocument(documentId: string): DocumentRecord | undefined {
  return store.get(documentId);
}
