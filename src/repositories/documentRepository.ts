import type { ExtractionResult } from '../services/extraction.js';

export interface DocumentRecord {
  documentId: string;
  filename: string;
  filePath: string;
  extraction: ExtractionResult;
  uploadedAt: Date;
}

export interface DocumentRepository {
  save(record: DocumentRecord): Promise<void>;
  findById(documentId: string): Promise<DocumentRecord | undefined>;
}
