import type { Classification } from '../schemas/classification.js';
import type { ExtractionResult } from '../services/extraction.js';

export interface DocumentRecord {
  documentId: string;
  filename: string;
  filePath: string;
  extraction: ExtractionResult;
  uploadedAt: Date;
  // Undefined until POST /documents/:id/classify succeeds at least once, at
  // which point the route persists the result here (previously the /classify
  // route returned this transiently without saving it anywhere — see
  // docs/week-2-day-2-dot-5.md for why that was a real gap, not just an
  // omission: without this, a later GET or batch-retrieval call had no way
  // to surface a document's classification at all).
  classification?: Classification;
}

export interface DocumentRepository {
  save(record: DocumentRecord): Promise<void>;
  findById(documentId: string): Promise<DocumentRecord | undefined>;
}
